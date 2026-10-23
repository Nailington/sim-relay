import net from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import path from 'node:path';

const socketPath = (directory: string) => path.join(directory, 'clients.sock');

/** A local-only administrator interface protected by the host state directory (0700). */
export async function clientAdminServer(
  directory: string,
  action: (request: unknown) => Promise<unknown>,
) {
  await chmod(directory, 0o700);
  const filename = socketPath(directory);
  // Never replace a socket owned by a running host.
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = net.connect(filename);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')) resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error('Another host is using this pairing directory. Stop it first.');
  await rm(filename, { force: true });
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    let input = '',
      handled = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      if (!input.includes('\n')) return;
      handled = true;
      void Promise.resolve()
        .then(() => action(JSON.parse(input.slice(0, input.indexOf('\n')))))
        .then((result) => socket.end(JSON.stringify({ result }) + '\n'))
        .catch((error: Error) => socket.end(JSON.stringify({ error: error.message }) + '\n'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(filename, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(filename, 0o600);
  return async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(filename, { force: true });
  };
}

export async function clientAdminRequest(directory: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath(directory));
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('The Mac host did not respond.')));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 1024 * 1024) socket.destroy(new Error('Unexpected host response.'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')
          ? new Error(
              'Start the Mac host first. Use the same SIM_RELAY_STATE_DIR as the running host.',
            )
          : error,
      ),
    );
    socket.once('end', () => {
      try {
        const response = JSON.parse(input);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
