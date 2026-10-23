import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { authorized } from './security';

const clientSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
});
type StoredClient = z.infer<typeof clientSchema>;
export type AuthorizedClient = Omit<StoredClient, 'digest'> & { activeSessions: number };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** The pairing code is single-use. Only credential hashes are stored by the host. */
export async function clientAuthorizations(directory: string) {
  const file = path.join(directory, 'clients.json');
  const tokenFile = path.join(directory, 'token');
  let records: StoredClient[];
  let pairingToken: string;
  const persist = async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, clients: records }), { mode: 0o600 });
    await rename(temporary, file);
  };
  const rotateCode = async () => {
    const next = randomBytes(24).toString('base64url');
    const temporary = `${tokenFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, tokenFile);
    pairingToken = next;
  };
  try {
    records = z
      .object({ version: z.literal(1), clients: z.array(clientSchema).max(1000) })
      .parse(JSON.parse(await readFile(file, 'utf8'))).clients;
    await chmod(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Migrate shared-token hosts by invalidating the old code, not granting it a client identity.
    records = [];
    await rotateCode();
    await persist();
  }
  pairingToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!pairingToken) throw new Error('The host pairing code is empty.');
  await chmod(tokenFile, 0o600);
  let queue = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  return {
    get pairingToken() {
      return pairingToken;
    },
    authenticate(header: string | undefined): string | undefined {
      if (!header?.startsWith('Bearer ') || header.length > 256) return;
      const hash = digest(header.slice(7));
      const record = records.find((client) => client.digest === hash);
      if (record) record.lastSeenAt = new Date().toISOString();
      return record?.id;
    },
    pair(header: string | undefined, name: string) {
      return serialize(async () => {
        if (!authorized(header, pairingToken))
          throw new Error(
            'Pairing code is incorrect or already used. Get the current code from the Mac.',
          );
        if (records.length >= 1000)
          throw new Error('Remove an authorized client before pairing another.');
        const token = randomBytes(32).toString('base64url');
        const record: StoredClient = {
          id: randomUUID(),
          name,
          digest: digest(token),
          createdAt: new Date().toISOString(),
        };
        // Consume the code before returning a credential. A failed write never grants access.
        await rotateCode();
        records.push(record);
        try {
          await persist();
        } catch (error) {
          records.pop();
          throw error;
        }
        return { id: record.id, token };
      });
    },
    list(active: (id: string) => number): AuthorizedClient[] {
      return records.map(({ digest: _digest, ...client }) => ({
        ...client,
        activeSessions: active(client.id),
      }));
    },
    revoke(id: string) {
      return serialize(async () => {
        const previous = records;
        records = records.filter((client) => client.id !== id);
        if (records.length === previous.length)
          throw new Error('This client is no longer authorized.');
        try {
          await persist();
        } catch (error) {
          records = previous;
          throw error;
        }
      });
    },
  };
}
