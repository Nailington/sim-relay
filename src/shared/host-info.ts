import { z } from 'zod';
import type { HostInfo } from './types';

// Increment only when the HTTPS/WebSocket API makes a breaking change.
export const HOST_PROTOCOL_VERSION = 1;
const legacyVersions = new Set(['0.1.0', '0.1.1', '0.1.2', '0.1.3']);
const hostInfoSchema = z.object({
  name: z.string().min(1).max(255),
  platform: z.literal('macOS'),
  version: z.string().min(1).max(64),
  protocolVersion: z.number().int().positive().optional(),
  clientAuthorization: z.boolean().optional(),
  xcode: z.boolean(),
  companion: z.boolean(),
});

export function parseHostInfo(value: unknown): HostInfo {
  const result = hostInfoSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      'This address did not return Sim Relay host information. Check the address and port shown on the Mac.',
    );
  const info = result.data;
  if (info.protocolVersion === undefined) {
    // These releases share protocol 1, but only advertised their application version.
    if (!legacyVersions.has(info.version))
      throw new Error(
        `Host ${info.version} does not advertise a supported connection protocol. Update Sim Relay on the client and host Mac.`,
      );
  } else if (info.protocolVersion !== HOST_PROTOCOL_VERSION) {
    throw new Error(
      `Host ${info.version} uses connection protocol ${info.protocolVersion}; this client supports ${HOST_PROTOCOL_VERSION}. Update Sim Relay on the client and host Mac.`,
    );
  }
  return info;
}
