import type { HostInfo, Inventory, Profile } from '../shared/types';
import { HOST_PROTOCOL_VERSION } from '../shared/host-info';
import {
  explainFailure,
  safeVersion,
  serializeReport,
  type DiagnosticEvent,
  type DiagnosticReport,
  type DiagnosticStage,
} from '../shared/diagnostics';

export function createDiagnostics(deps: {
  version: string;
  platform: string;
  profile(id: string): Profile;
  probe(url: string): Promise<{ info: HostInfo; fingerprint: string }>;
  inventory(profile: Profile): Promise<Inventory>;
  now?: () => Date;
}) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  // Deliberately retain only stage/outcome, never request payloads, host stdout,
  // addresses, names, pasted text, commands, screenshots, tokens, or raw errors.
  const events: (DiagnosticEvent & { hostId?: string })[] = [];
  const record = (stage: DiagnosticStage, state: DiagnosticEvent['state'], hostId?: string) => {
    events.push({ at: now(), stage, state, hostId });
    if (events.length > 100) events.shift();
  };
  const failure = (error: unknown, stage: DiagnosticStage, hostId?: string) =>
    record(explainFailure(error, stage).stage, 'failed', hostId);
  const refresh = async (id?: string): Promise<DiagnosticReport> => {
    const report: DiagnosticReport = {
      format: 'sim-relay-diagnostics-v1',
      generatedAt: now(),
      client: {
        version: safeVersion(deps.version) ?? '0.0.0',
        platform: ['darwin', 'win32', 'linux'].includes(deps.platform)
          ? (deps.platform as 'darwin' | 'win32' | 'linux')
          : 'other',
        protocol: HOST_PROTOCOL_VERSION,
      },
      host: { version: null, protocol: null, legacyProtocol: false, observedAt: null },
      checks: [
        'network',
        'tls',
        'authentication',
        'compatibility',
        'xcode',
        'runtimes',
        'companion',
      ].map((stage) => ({ stage: stage as DiagnosticStage, state: 'unavailable' })),
      runtimeCount: null,
      events: [],
    };
    const set = (stage: DiagnosticStage, state: DiagnosticEvent['state']) => {
      const check = report.checks.find((c) => c.stage === stage);
      if (check) check.state = state;
      record(stage, state, id);
    };
    if (id) {
      let p: Profile | undefined;
      try {
        p = deps.profile(id);
      } catch {
        set('authentication', 'failed');
      }
      if (p) {
        try {
          const probe = await deps.probe(p.url);
          set('network', 'passed');
          if (probe.fingerprint !== p.fingerprint) {
            set('tls', 'failed');
          } else {
            // Do not treat a bootstrap probe as authenticated host data. Confirm
            // the pinned TLS connection and credential before trusting readiness.
            set('compatibility', 'passed');
            try {
              const inventory = await deps.inventory(p);
              set('tls', 'passed');
              set('authentication', 'passed');
              report.host = {
                version: safeVersion(probe.info.version),
                protocol: probe.info.protocolVersion ?? 1,
                legacyProtocol: probe.info.protocolVersion === undefined,
                observedAt: now(),
              };
              set('xcode', probe.info.xcode ? 'passed' : 'failed');
              set('companion', probe.info.companion ? 'passed' : 'failed');
              report.runtimeCount = Math.min(
                1000,
                inventory.runtimes.filter((r) => r.isAvailable).length,
              );
              set('runtimes', report.runtimeCount > 0 ? 'passed' : 'failed');
            } catch (error) {
              const stage = explainFailure(error, 'runtimes').stage;
              // An HTTP authentication/setup error implies pinned TLS succeeded.
              if (['authentication', 'runtimes', 'xcode'].includes(stage)) set('tls', 'passed');
              if (['runtimes', 'xcode'].includes(stage)) set('authentication', 'passed');
              set(stage, 'failed');
            }
          }
        } catch (error) {
          set(explainFailure(error, 'network').stage, 'failed');
        }
      }
    }
    report.events = events.filter((e) => e.hostId === id).map(({ hostId: _id, ...event }) => event);
    // Validate at the boundary, even before presenting a review.
    return JSON.parse(serializeReport(report));
  };
  return { refresh, record, failure };
}
