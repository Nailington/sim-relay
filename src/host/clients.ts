import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { authorized } from './security';
import {
  clientPermissionsSchema,
  legacyClientPermissions,
  newClientPermissions,
  type ClientPermissions,
} from '../shared/permissions';

const legacyClientSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
});
const clientSchema = legacyClientSchema.extend({
  permissions: clientPermissionsSchema,
  permissionRevision: z.number().int().nonnegative().safe(),
});
type StoredClient = z.infer<typeof clientSchema>;
export type AuthorizedClient = Omit<StoredClient, 'digest'> & { activeSessions: number };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** The pairing code is single-use. Only credential hashes are stored by the host. */
export async function clientAuthorizations(
  directory: string,
  changed: (id: string) => void = () => {},
) {
  const file = path.join(directory, 'clients.json');
  const tokenFile = path.join(directory, 'token');
  let records: StoredClient[];
  let pairingToken: string;
  const persist = async (snapshot = records) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, clients: snapshot }), { mode: 0o600 });
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
    const saved = z
      .discriminatedUnion('version', [
        z.object({ version: z.literal(1), clients: z.array(legacyClientSchema).max(1000) }),
        z.object({ version: z.literal(2), clients: z.array(clientSchema).max(1000) }),
      ])
      .parse(JSON.parse(await readFile(file, 'utf8')));
    records =
      saved.version === 1
        ? saved.clients.map((client) => ({
            ...client,
            permissions: legacyClientPermissions(),
            permissionRevision: 0,
          }))
        : saved.clients;
    if (saved.version === 1) await persist();
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
          permissions: newClientPermissions(),
          permissionRevision: 0,
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
    get(id: string) {
      const record = records.find((client) => client.id === id);
      if (!record) return;
      const { digest: _digest, ...client } = record;
      return structuredClone(client);
    },
    setPermissions(id: string, expectedRevision: number, permissions: ClientPermissions) {
      const parsed = clientPermissionsSchema.parse(permissions);
      return serialize(async () => {
        const record = records.find((client) => client.id === id);
        if (!record) throw new Error('This client is no longer authorized.');
        if (record.permissionRevision !== expectedRevision)
          throw new Error('Permissions changed. Refresh the client list before saving again.');
        const previous = record.permissions;
        if (record.permissionRevision === Number.MAX_SAFE_INTEGER)
          throw new Error('Permission revision exhausted. Revoke this client and pair it again.');
        record.permissions = newClientPermissions();
        record.permissionRevision++;
        // Fail closed before filesystem I/O; a failed save still invalidates old requests.
        changed(id);
        try {
          await persist(
            records.map((client) =>
              client.id === id ? { ...client, permissions: parsed } : client,
            ),
          );
          // Publish grants only after durable save. Requests begun during the deny
          // window must not become newly privileged when that save completes.
          record.permissions = parsed;
          changed(id);
        } catch (error) {
          record.permissions = previous;
          changed(id);
          throw error;
        }
      });
    },
    list(active: (id: string) => number): AuthorizedClient[] {
      return records.map(({ digest: _digest, ...client }) => ({
        ...structuredClone(client),
        activeSessions: active(client.id),
      }));
    },
    revoke(id: string) {
      return serialize(async () => {
        const previous = records;
        records = records.filter((client) => client.id !== id);
        if (records.length === previous.length)
          throw new Error('This client is no longer authorized.');
        changed(id);
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
