import type { Profile } from './types';

export const recoveryMessages = {
  legacy_pairing:
    'Old shared pairing: this Mac now uses protocol 2 client authorization. Update the client, then pair this device again with the current single-use code from Share this Mac or sim-relay-host pairing. Keep the saved certificate and simulator data.',
  pairing_code_invalid:
    'Pairing code is incorrect or already used. Refresh the current single-use code in Share this Mac or run sim-relay-host pairing, then enter the new code.',
  legacy_code_invalid:
    'The shared code for this protocol 1 host is incorrect. Copy its current shared code from Share this Mac or sim-relay-host pairing. This older host does not rotate its code after each pairing.',
  authorization_required:
    'This device is no longer authorized. Ask the Mac owner whether access was revoked, then pair again with the current single-use code if access should be restored.',
  permission_denied:
    'Permission required: the Mac owner has not granted this action or simulator. Ask the owner to change this client’s permissions; pairing again does not grant access.',
} as const;
export type RecoveryCode = keyof typeof recoveryMessages;

/** Token shape is only a migration hint. Host verification alone decides authorization. */
export function remoteRecovery(
  profile: Pick<Profile, 'token' | 'authorizationMode'>,
  pathname: string,
  status: number,
  code?: string,
): { code: RecoveryCode; message: string } | undefined {
  if (status === 403 && code === 'permission_denied')
    return { code: 'permission_denied', message: recoveryMessages.permission_denied };
  if (status !== 401) return;
  if (pathname === '/pair')
    return { code: 'pairing_code_invalid', message: recoveryMessages.pairing_code_invalid };
  if (
    profile.authorizationMode === 'legacy' ||
    (profile.authorizationMode === undefined && /^[\w-]{32}$/.test(profile.token))
  )
    return { code: 'legacy_pairing', message: recoveryMessages.legacy_pairing };
  return { code: 'authorization_required', message: recoveryMessages.authorization_required };
}

export function recoveryAdvice(message: string) {
  if (/Old shared pairing:/i.test(message))
    return {
      stage: 'authentication' as const,
      title: 'Pair this device again after the host upgrade',
      next: recoveryMessages.legacy_pairing.replace('Old shared pairing: ', ''),
    };
  if (/Permission required:|permission_denied|permissions changed on the Mac/i.test(message))
    return {
      stage: 'authentication' as const,
      title: 'The Mac owner needs to grant access',
      next: recoveryMessages.permission_denied.replace('Permission required: ', ''),
    };
  if (/Pairing code is incorrect or already used/i.test(message))
    return {
      stage: 'authentication' as const,
      title: 'Get the current pairing code',
      next: recoveryMessages.pairing_code_invalid,
    };
  if (/shared code for this protocol 1 host is incorrect/i.test(message))
    return {
      stage: 'authentication' as const,
      title: 'Check the older host’s shared code',
      next: recoveryMessages.legacy_code_invalid,
    };
}
