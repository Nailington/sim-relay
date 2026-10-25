import { clipboard } from 'electron';
import { z } from 'zod';
import { createServiceManager } from '../host/service-manager';

/** Registered through main.handle so every call retains sender-window/frame validation. */
export function registerHostManagement(
  handle: (channel: string, action: (...args: any[]) => unknown) => void,
  manager: ReturnType<typeof createServiceManager>,
) {
  const id = z.string().uuid();
  const permissions = z
    .object({
      role: z.enum(['viewer', 'controller']),
      devices: z.union([z.literal('all'), z.array(id).max(1000)]),
      installation: z.boolean(),
      destructive: z.boolean(),
      rawSimctl: z.boolean(),
      screenshots: z.boolean(),
      recordings: z.boolean(),
      hostAudio: z.boolean(),
    })
    .strict();
  const settings = z
    .object({
      directory: z.string().min(1).max(4096),
      port: z.number().int().min(1).max(65535),
      bind: z.string().min(1).max(255),
      companionPath: z.string().max(4096),
      hostAudio: z.boolean(),
      audioHelper: z.string().max(4096),
      startAtLogin: z.boolean(),
    })
    .strict();
  handle('host-management-status', () => manager.status());
  handle('host-management-action', (action: unknown) =>
    manager.action(z.enum(['start', 'stop', 'restart']).parse(action)),
  );
  handle('host-management-settings', (value: unknown) =>
    manager.saveSettings(settings.parse(value)),
  );
  handle('host-management-login', (enabled: unknown) =>
    manager.setLogin(z.boolean().parse(enabled)),
  );
  handle('host-management-awake', (enabled: unknown) =>
    manager.keepAwake(z.boolean().parse(enabled)),
  );
  handle('host-management-pairing', () => manager.pairing());
  handle('host-management-copy-pairing', async () => {
    // Always retrieve at copy time; the last displayed code may have been consumed.
    clipboard.writeText((await manager.pairing()).token);
  });
  handle('host-management-clients', () => manager.admin({ action: 'list' }));
  handle('host-management-revoke', async (value: unknown) => {
    await manager.admin({ action: 'revoke', id: id.parse(value) });
  });
  handle('host-management-permissions', (value: unknown, revision: unknown, scope: unknown) =>
    manager.admin({
      action: 'permissions',
      id: id.parse(value),
      expectedRevision: z.number().int().positive().parse(revision),
      permissions: permissions.parse(scope),
    }),
  );
}
