import { allowsDevice, type ClientPermissions } from '../shared/permissions';

export const permissionDenied = {
  code: 'permission_denied',
  error: 'The Mac owner has not granted permission for this action.',
};
export class PermissionDenied extends Error {
  readonly code = 'permission_denied';
  constructor() {
    super(permissionDenied.error);
  }
}
export type Capability =
  | 'view'
  | 'control'
  | 'installation'
  | 'destructive'
  | 'rawSimctl'
  | 'screenshots'
  | 'recordings'
  | 'hostAudio'
  | 'create';
export function requirePermission(p: ClientPermissions, capability: Capability, udid?: string) {
  if (udid && !allowsDevice(p, udid)) throw new PermissionDenied();
  if (
    ['control', 'installation', 'destructive', 'rawSimctl', 'create'].includes(capability) &&
    p.role !== 'controller'
  )
    throw new PermissionDenied();
  if (capability === 'create' && p.devices !== 'all') throw new PermissionDenied();
  if (
    !['view', 'control', 'create'].includes(capability) &&
    !p[capability as keyof ClientPermissions]
  )
    throw new PermissionDenied();
}

/** Treat simctl as a structured API, never a shell or an escape from the upload API.
 * Unknown subcommands/options, aliases (booted/all), host paths, spawn, runtime,
 * clone/pair and global settings are deliberately unavailable to remote callers.
 */
export function requireCommand(p: ClientPermissions, args: string[]) {
  requirePermission(p, 'rawSimctl');
  const [command, udid, ...rest] = args;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(udid ?? ''))
    throw new PermissionDenied();
  requirePermission(p, 'control', udid);
  let valid = false;
  switch (command) {
    case 'boot':
    case 'shutdown':
      valid = rest.length === 0;
      break;
    case 'bootstatus':
      valid = rest.length === 0 || (rest.length === 1 && rest[0] === '-b');
      break;
    case 'erase':
    case 'delete':
      requirePermission(p, 'destructive', udid);
      valid = rest.length === 0;
      break;
    case 'uninstall':
      requirePermission(p, 'installation', udid);
      requirePermission(p, 'destructive', udid);
      valid = rest.length === 1 && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(rest[0]);
      break;
    case 'terminate':
    case 'launch':
    case 'appinfo':
      valid = rest.length === 1 && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(rest[0]);
      break;
    case 'listapps':
      valid = rest.length === 0;
      break;
    case 'ui':
      valid = rest.length === 2 && rest[0] === 'appearance' && ['light', 'dark'].includes(rest[1]);
      break;
    case 'location':
      valid = rest.length === 1 && rest[0] === 'clear';
      if (rest.length === 2 && rest[0] === 'set') {
        const parts = rest[1].split(',');
        const [latitude, longitude] = parts.map(Number);
        valid =
          parts.length === 2 &&
          parts.every((part) => /^-?\d+(\.\d+)?$/.test(part)) &&
          Math.abs(latitude) <= 90 &&
          Math.abs(longitude) <= 180;
      }
      break;
    case 'openurl':
      valid = rest.length === 1 && safeDeviceURL(rest[0]);
      break;
  }
  if (!valid) throw new PermissionDenied();
}
export function safeDeviceURL(value: string) {
  // file URLs resolve host files through CoreSimulator; no host file access is delegated.
  return (
    !/[\x00-\x20\x7f]/.test(value) && /^[a-z][a-z\d+.-]*:/i.test(value) && !/^file:/i.test(value)
  );
}
