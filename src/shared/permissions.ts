import { z } from 'zod';

/** Full replacement, never a merge with implicit grants. Device IDs are case insensitive. */
export const clientPermissionsSchema = z.strictObject({
  role: z.enum(['viewer', 'controller']),
  devices: z.union([
    z.literal('all'),
    z
      .array(
        z
          .string()
          .uuid()
          .transform((id) => id.toUpperCase()),
      )
      .max(1000),
  ]),
  installation: z.boolean(),
  destructive: z.boolean(),
  rawSimctl: z.boolean(),
  screenshots: z.boolean(),
  recordings: z.boolean(),
  hostAudio: z.boolean(),
});
export type ClientPermissions = z.infer<typeof clientPermissionsSchema>;
export const newClientPermissions = (): ClientPermissions => ({
  role: 'viewer',
  devices: [],
  installation: false,
  destructive: false,
  rawSimctl: false,
  screenshots: false,
  recordings: false,
  hostAudio: false,
});
/** Only v1 records already present on disk receive this one-time compatibility grant. */
export const legacyClientPermissions = (): ClientPermissions => ({
  role: 'controller',
  devices: 'all',
  installation: true,
  destructive: true,
  rawSimctl: true,
  screenshots: true,
  recordings: true,
  hostAudio: true,
});
export function allowsDevice(permissions: ClientPermissions, udid: string) {
  return permissions.devices === 'all' || permissions.devices.includes(udid.toUpperCase());
}
