import { z } from 'zod';

export const stages = [
  'network',
  'tls',
  'authentication',
  'compatibility',
  'xcode',
  'runtimes',
  'companion',
  'boot',
  'stream',
  'input',
  'action',
] as const;
export type DiagnosticStage = (typeof stages)[number];
export type CheckState = 'passed' | 'failed' | 'unavailable';
export const stageLabels: Record<DiagnosticStage, string> = {
  network: 'Network',
  tls: 'Certificate verification',
  authentication: 'Client authorization',
  compatibility: 'Protocol compatibility',
  xcode: 'Xcode',
  runtimes: 'Simulator runtimes',
  companion: 'Input and video companion',
  boot: 'Simulator boot',
  stream: 'Display stream',
  input: 'Input service',
  action: 'Simulator action',
};
const advice: Record<DiagnosticStage, { title: string; next: string }> = {
  action: {
    title: 'The simulator action could not finish',
    next: 'Check the selected Mac and simulator, review the action’s fields, and try again. Open Diagnostics if the host is not responding.',
  },
  network: {
    title: 'The Mac could not be reached',
    next: 'Keep the Mac awake and sharing. Check its address, network or SSH tunnel, and allow TCP 49300 through its firewall.',
  },
  tls: {
    title: 'The Mac’s certificate could not be verified',
    next: 'Compare the fingerprint on the Mac. If its certificate was replaced, pair again only after verifying the new fingerprint.',
  },
  authentication: {
    title: 'This client is not authorized',
    next: 'Pair again with the current pairing code from the Mac. Ask the Mac owner whether access was revoked.',
  },
  compatibility: {
    title: 'Client and host protocols are incompatible',
    next: 'Update Sim Relay on both computers, restart sharing, and pair again.',
  },
  xcode: {
    title: 'Xcode is not ready',
    next: 'Open Xcode on the Mac to finish setup. Select it with xcode-select, then restart sharing.',
  },
  runtimes: {
    title: 'Simulator runtimes could not be loaded',
    next: 'Install an iOS runtime in Xcode → Settings → Components on the Mac, then refresh health.',
  },
  companion: {
    title: 'The input and video companion is not ready',
    next: 'On the Mac, install idb-companion with Homebrew and restart sharing. Check IDB_COMPANION_PATH if you use a custom location.',
  },
  boot: {
    title: 'The simulator could not start',
    next: 'Refresh simulators and try Start & connect again. If it still fails, open this simulator on the Mac and check its runtime.',
  },
  stream: {
    title: 'The display stream stopped',
    next: 'Reconnect the display. If it stops again, check the Mac’s companion and network in Diagnostics.',
  },
  input: {
    title: 'Simulator input failed',
    next: 'Reconnect the display to restart its input session. Check idb-companion on the Mac if controls still do not respond.',
  },
};
export function explainFailure(error: unknown, fallback: DiagnosticStage = 'network') {
  const message = error instanceof Error ? error.message : String(error);
  let stage = fallback;
  if (/certificate|fingerprint|self.signed|CERT_|TLS|SSL/i.test(message)) stage = 'tls';
  else if (/ENOTFOUND|ECONNREFUSED|EHOST|ENET|ETIMEDOUT/i.test(message)) stage = 'network';
  else if (/401|403|unauthori|pairing|credential|revok|token.*incorrect/i.test(message))
    stage = 'authentication';
  else if (/protocol|incompatible|host information/i.test(message)) stage = 'compatibility';
  else if (
    /ENOTFOUND|ECONNREFUSED|EHOST|ENET|ETIMEDOUT|cannot reach|timed? out|too long/i.test(message)
  )
    stage = 'network';
  else if (/xcode|xcode-select|developer directory/i.test(message)) stage = 'xcode';
  else if (/runtime/i.test(message)) stage = 'runtimes';
  else if (/companion|idb/i.test(message)) stage = 'companion';
  else if (/HID|input|key.*event|touch/i.test(message)) stage = 'input';
  else if (/boot/i.test(message)) stage = 'boot';
  else if (/stream|decode|video|websocket/i.test(message)) stage = 'stream';
  return { stage, ...advice[stage] };
}

// Display-only technical details. Export uses a strict, structured allowlist below,
// never arbitrary error strings, request arguments, host output, or this function.
export function redactSecrets(text: string, knownSecrets: string[] = []): string {
  let result = text;
  for (const secret of knownSecrets.filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[redacted]');
  return result
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gi,
      '[redacted key or certificate]',
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 [redacted]')
    .replace(
      /((?:["']?)(?:[\w-]*(?:token|password|secret|credential|authorization|cookie|api[_-]?key)[\w-]*)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, '[host address removed]')
    .replace(/\b[\da-f]{32,}\b/gi, '[redacted value]')
    .replace(/(?:\/(?:Users|home)\/|[A-Z]:\\Users\\)[^\s"']+/gi, '[local path removed]');
}

const stageSchema = z.enum(stages);
const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/);
const timestamp = z.string().datetime();
export const reportSchema = z
  .object({
    format: z.literal('sim-relay-diagnostics-v1'),
    generatedAt: timestamp,
    client: z
      .object({
        version,
        platform: z.enum(['darwin', 'win32', 'linux', 'browser', 'other']),
        protocol: z.number().int().min(1).max(1000),
      })
      .strict(),
    host: z
      .object({
        version: version.nullable(),
        protocol: z.number().int().min(1).max(1000).nullable(),
        legacyProtocol: z.boolean(),
        observedAt: timestamp.nullable(),
      })
      .strict()
      .optional(),
    session: z
      .object({
        booted: z.boolean().nullable(),
        stream: z.enum(['off', 'connecting', 'live']),
        decodedFps: z.number().int().min(0).max(1000),
      })
      .strict()
      .optional(),
    checks: z
      .array(
        z
          .object({ stage: stageSchema, state: z.enum(['passed', 'failed', 'unavailable']) })
          .strict(),
      )
      .max(10),
    runtimeCount: z.number().int().min(0).max(1000).nullable().optional(),
    events: z
      .array(
        z
          .object({
            at: timestamp,
            stage: stageSchema,
            state: z.enum(['passed', 'failed', 'unavailable']),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type DiagnosticReport = z.infer<typeof reportSchema>;
export type DiagnosticEvent = DiagnosticReport['events'][number];
export type DiagnosticCheck = DiagnosticReport['checks'][number];
export function safeVersion(value: string): string | null {
  const parsed = version.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function serializeReport(value: unknown): string {
  // Strict schemas reject unknown keys rather than silently saving a hidden secret.
  return JSON.stringify(reportSchema.parse(value), null, 2) + '\n';
}
export function failureAdvice(stage: DiagnosticStage) {
  return advice[stage];
}
