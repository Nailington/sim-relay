import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnostics } from '../src/electron/diagnostics';
import { explainFailure, redactSecrets, serializeReport } from '../src/shared/diagnostics';
import type { HostInfo, Inventory, Profile } from '../src/shared/types';

const secret = 'private-sensitive-value-never-export';
const profile: Profile = {
  id: 'host-1',
  name: 'Private Mac name',
  url: 'https://private-mac.local:49300',
  token: secret,
  certificate: 'PRIVATE CERT',
  fingerprint: 'PINNED',
  source: 'saved',
};
const info: HostInfo = {
  name: profile.name,
  version: '0.1.5',
  platform: 'macOS',
  protocolVersion: 1,
  xcode: true,
  companion: true,
};
const inventory: Inventory = {
  devices: [],
  runtimes: [{ identifier: 'runtime', name: secret, version: '26.0', isAvailable: true }],
  devicetypes: [],
};
function fixture(overrides: Partial<Parameters<typeof createDiagnostics>[0]> = {}) {
  return createDiagnostics({
    version: '0.1.5',
    platform: 'linux',
    profile: () => profile,
    probe: async () => ({ info, fingerprint: 'PINNED' }),
    inventory: async () => inventory,
    now: () => new Date('2026-10-23T12:00:00Z'),
    ...overrides,
  });
}
const state = (report: Awaited<ReturnType<ReturnType<typeof fixture>['refresh']>>, stage: string) =>
  report.checks.find((check) => check.stage === stage)?.state;

test('healthy host validates pinned identity and authorization before reporting readiness', async () => {
  const report = await fixture().refresh('host-1');
  assert.ok(report.checks.every((check) => check.state === 'passed'));
  assert.equal(report.runtimeCount, 1);
  assert.equal(report.host?.version, info.version);
  const serialized = serializeReport(report);
  for (const value of [
    secret,
    profile.url,
    profile.name,
    profile.certificate,
    profile.fingerprint,
    'host-1',
  ])
    assert.ok(!serialized.includes(value));
});
test('unreachable host remains useful offline, with unknown setup distinguished from failure', async () => {
  const report = await fixture({
    probe: async () => {
      throw new Error(`ECONNREFUSED ${secret}`);
    },
  }).refresh('host-1');
  assert.equal(state(report, 'network'), 'failed');
  for (const stage of ['tls', 'authentication', 'xcode', 'runtimes', 'companion'])
    assert.equal(state(report, stage), 'unavailable');
  assert.equal(report.host?.observedAt, null);
  assert.equal(report.client.platform, 'linux');
  assert.ok(!serializeReport(report).includes(secret));
});
test('certificate mismatch never sends a credential or trusts host readiness', async () => {
  let requested = false;
  const report = await fixture({
    probe: async () => ({ info, fingerprint: 'CHANGED' }),
    inventory: async () => {
      requested = true;
      return inventory;
    },
  }).refresh('host-1');
  assert.equal(requested, false);
  assert.equal(state(report, 'network'), 'passed');
  assert.equal(state(report, 'tls'), 'failed');
  assert.equal(state(report, 'xcode'), 'unavailable');
});
test('authorization failure confirms pinned TLS but leaves setup data unavailable', async () => {
  const report = await fixture({
    inventory: async () => {
      throw new Error('HTTP 401 credential revoked');
    },
  }).refresh('host-1');
  assert.equal(state(report, 'tls'), 'passed');
  assert.equal(state(report, 'authentication'), 'failed');
  assert.equal(state(report, 'companion'), 'unavailable');
  assert.equal(report.runtimeCount, null);
});
test('incompatible protocol does not infer reachability or readiness from failed probe', async () => {
  const report = await fixture({
    probe: async () => {
      throw new Error('Host uses connection protocol 99');
    },
  }).refresh('host-1');
  assert.equal(state(report, 'compatibility'), 'failed');
  assert.equal(state(report, 'xcode'), 'unavailable');
});
test('missing dependencies and unavailable runtimes are confirmed setup failures', async () => {
  const report = await fixture({
    probe: async () => ({
      info: { ...info, xcode: false, companion: false },
      fingerprint: 'PINNED',
    }),
    inventory: async () => ({
      ...inventory,
      runtimes: [{ ...inventory.runtimes[0], isAvailable: false }],
    }),
  }).refresh('host-1');
  for (const stage of ['xcode', 'companion', 'runtimes'])
    assert.equal(state(report, stage), 'failed');
  assert.equal(report.runtimeCount, 0);
});
test('legacy protocol is labeled and invalid remote version is withheld', async () => {
  const report = await fixture({
    probe: async () => ({
      info: { ...info, version: secret, protocolVersion: undefined },
      fingerprint: 'PINNED',
    }),
  }).refresh('host-1');
  assert.equal(report.host?.legacyProtocol, true);
  assert.equal(report.host?.version, null);
  assert.ok(!serializeReport(report).includes(secret));
});
test('recent events are bounded, scoped to selected host, and contain no arbitrary errors', async () => {
  const diagnostics = fixture();
  for (let i = 0; i < 150; i++) diagnostics.failure(new Error(secret), 'input', 'host-1');
  diagnostics.record('boot', 'passed', 'host-2');
  const report = await diagnostics.refresh();
  assert.equal(report.events.length, 0);
  const host = await diagnostics.refresh('host-1');
  assert.ok(host.events.length <= 100);
  assert.ok(host.events.some((e) => e.stage === 'input' && e.state === 'failed'));
  assert.ok(!serializeReport(host).includes(secret));
});
test('export rejects secrets in extra fields, arbitrary events, or malformed version strings', async () => {
  const report = await fixture().refresh();
  for (const injected of [
    { ...report, token: secret },
    { ...report, host: { ...report.host, certificate: secret } },
    {
      ...report,
      events: [{ at: report.generatedAt, stage: 'stream', state: 'failed', message: secret }],
    },
    { ...report, client: { ...report.client, version: secret } },
    { ...report, client: { ...report.client, version: `0.1.5-${secret}` } },
  ])
    assert.throws(() => serializeReport(injected));
});
test('report review omissions serialize exactly and do not regain excluded content', async () => {
  const report = await fixture().refresh('host-1');
  const reviewed = { ...report, host: undefined, runtimeCount: undefined, events: [] };
  const serialized = serializeReport(reviewed);
  assert.deepEqual(JSON.parse(serialized), {
    format: report.format,
    generatedAt: report.generatedAt,
    client: report.client,
    checks: report.checks,
    events: [],
  });
});
test('common failures get stage-specific recovery guidance', () => {
  for (const [message, stage] of [
    ['ENOTFOUND host', 'network'],
    ['certificate changed', 'tls'],
    ['credential revoked', 'authentication'],
    ['protocol 99', 'compatibility'],
    ['Xcode not ready', 'xcode'],
    ['runtime missing', 'runtimes'],
    ['idb unavailable', 'companion'],
    ['boot failed', 'boot'],
    ['Cannot decode video', 'stream'],
    ['HID RPC failed', 'input'],
  ] as const) {
    const failure = explainFailure(new Error(message));
    assert.equal(failure.stage, stage);
    assert.ok(failure.next.length > 30);
  }
});
test('technical detail redaction removes common credential formats and paths', () => {
  const raw = `${secret}\nAuthorization: Bearer abc.def.xyz\n{"token":"long secret value", "api_key":"abc123"}\npassword=hunter2\nhttps://user:password@host:49300/?token=abc\n/Users/alice/project/file\n-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----`;
  const redacted = redactSecrets(raw, [secret]);
  for (const value of [
    secret,
    'abc.def.xyz',
    'long secret value',
    'abc123',
    'hunter2',
    'user:password',
    'alice',
    'private material',
  ])
    assert.ok(!redacted.includes(value), value);
});

test('real HTTPS health checks verify pinned transport and distinguish invalid credentials', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const https = await import('node:https');
  const { identity } = await import('../src/host/security');
  const { probeHost, remoteRequest } = await import('../src/electron/remote');
  const directory = await mkdtemp(join(tmpdir(), 'sim-relay-diagnostics-'));
  const identityData = await identity(directory);
  const requestAuthorizations: (string | undefined)[] = [];
  const server = https.createServer(
    { cert: identityData.cert, key: identityData.key },
    (req, res) => {
      requestAuthorizations.push(req.headers.authorization);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/info') res.end(JSON.stringify(info));
      else if (req.url === '/devices' && req.headers.authorization === `Bearer ${secret}`)
        res.end(JSON.stringify(inventory));
      else {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: `Pairing token is incorrect: ${secret}` }));
      }
    },
  );
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    const pinned = {
      ...profile,
      url,
      certificate: identityData.cert.toString(),
      fingerprint: identityData.fingerprint,
    };
    const deps = {
      profile: () => pinned,
      probe: probeHost,
      inventory: async (p: Profile) =>
        JSON.parse(
          (await remoteRequest(p, 'GET', '/devices', undefined, 1000)).toString(),
        ) as Inventory,
    };
    const report = await fixture(deps).refresh('host-1');
    assert.equal(state(report, 'tls'), 'passed');
    assert.equal(state(report, 'authentication'), 'passed');
    assert.deepEqual(requestAuthorizations, [undefined, `Bearer ${secret}`]);
    const denied = await fixture({
      ...deps,
      profile: () => ({ ...pinned, token: 'incorrect' }),
    }).refresh('host-1');
    assert.equal(state(denied, 'authentication'), 'failed');
    assert.ok(!serializeReport(denied).includes(secret));
    const before = requestAuthorizations.length;
    const changed = await fixture({
      ...deps,
      profile: () => ({ ...pinned, fingerprint: 'CHANGED' }),
    }).refresh('host-1');
    assert.equal(state(changed, 'tls'), 'failed');
    assert.equal(requestAuthorizations.length, before + 1);
    assert.equal(requestAuthorizations.at(-1), undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
