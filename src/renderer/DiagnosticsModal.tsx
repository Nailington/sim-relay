import { useEffect, useState } from 'react';
import { Activity, ArrowDownToLine, Check, RefreshCw } from 'lucide-react';
import type { DesktopApi, HostEntry } from '../shared/types';
import { HOST_PROTOCOL_VERSION } from '../shared/host-info';
import {
  explainFailure,
  failureAdvice,
  serializeReport,
  stageLabels,
  type DiagnosticReport,
} from '../shared/diagnostics';
import metadata from '../../package.json';
import { Busy, Modal } from './components';

export function DiagnosticsModal({
  api,
  host,
  stream,
  fps,
  failureStage,
  onClose,
}: {
  api?: DesktopApi;
  host?: HostEntry;
  stream: 'off' | 'connecting' | 'live';
  fps: number;
  failureStage?: import('../shared/diagnostics').DiagnosticStage;
  onClose(): void;
}) {
  const [report, setReport] = useState<DiagnosticReport>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [review, setReview] = useState(false),
    [includeEvents, setIncludeEvents] = useState(true);
  const [includeHost, setIncludeHost] = useState(true),
    [saved, setSaved] = useState(false);
  const demo = !api || host?.source === 'demo';
  const refresh = async () => {
    setBusy(true);
    setError('');
    setReview(false);
    setSaved(false);
    try {
      if (!demo && api.diagnostics) {
        const health = await api.diagnostics(host?.source === 'saved' ? host.id : undefined);
        health.session = {
          booted: stream === 'live' && fps > 0 ? true : null,
          stream,
          decodedFps: Math.min(1000, Math.max(0, Math.round(fps))),
        };
        for (const stage of ['boot', 'stream', 'input'] as const) {
          health.checks.push({
            stage,
            state:
              failureStage === stage
                ? 'failed'
                : (stage === 'boot' && stream === 'live' && fps > 0) ||
                    (stage === 'stream' && stream === 'live' && fps > 0)
                  ? 'passed'
                  : 'unavailable',
          });
        }
        setReport(health);
      } else
        setReport({
          format: 'sim-relay-diagnostics-v1',
          generatedAt: new Date().toISOString(),
          client: {
            version: metadata.version,
            platform: api?.platform === 'darwin' ? 'darwin' : !api ? 'browser' : 'other',
            protocol: HOST_PROTOCOL_VERSION,
          },
          checks: [],
          events: [],
        });
    } catch (e) {
      const failure = explainFailure(e);
      setError(`${failure.title}. ${failure.next}`);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const reviewed = report && {
    ...report,
    host: includeHost ? report.host : undefined,
    runtimeCount: includeHost ? report.runtimeCount : undefined,
    events: includeEvents ? report.events : [],
  };
  return (
    <Modal
      title={review ? 'Review diagnostic report' : 'Diagnostics'}
      subtitle={
        host ? `Health of ${host.name}` : 'Client health. Select a paired Mac to check its host.'
      }
      onClose={onClose}
    >
      {(demo || !api?.diagnostics) && (
        <div className="info-box">
          <p>
            {!api
              ? 'Browser preview cannot check a real Mac. Client version and protocol are available offline.'
              : host?.source === 'demo'
                ? 'Demo data is excluded from health checks. Select a paired Mac to check its real services.'
                : 'This app does not expose host diagnostics. Update the desktop app to check health.'}
          </p>
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {report && !review && (
        <>
          <dl className="version-list">
            <div>
              <dt>Client</dt>
              <dd>
                {report.client.version} / {report.client.platform}
              </dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>{report.client.protocol}</dd>
            </div>
            <div>
              <dt>Host</dt>
              <dd>
                {report.host?.version ?? 'Unavailable'}
                {report.host?.legacyProtocol
                  ? ' (legacy protocol 1)'
                  : report.host?.protocol
                    ? ` / protocol ${report.host.protocol}`
                    : ''}
              </dd>
            </div>
            <div>
              <dt>Display</dt>
              <dd>
                {demo
                  ? 'Simulated preview'
                  : stream === 'live'
                    ? 'Connected; input not independently verified'
                    : stream === 'connecting'
                      ? 'Connecting'
                      : 'Disconnected'}
              </dd>
            </div>
          </dl>
          <p className="field-hint">
            Checked {new Date(report.generatedAt).toLocaleTimeString()}. Host readiness is checked
            when sharing starts; restart sharing after changing Xcode or the companion.
          </p>
          <div className="health-checks">
            {report.checks.map((check) => (
              <div key={check.stage} className={`health-check ${check.state}`}>
                <div>
                  <strong>{stageLabels[check.stage]}</strong>
                  <span>
                    {check.state === 'passed'
                      ? 'Ready'
                      : check.state === 'failed'
                        ? 'Needs attention'
                        : 'Unavailable'}
                  </span>
                </div>
                {check.state === 'failed' ? (
                  <p>{failureAdvice(check.stage).next}</p>
                ) : check.state === 'unavailable' ? (
                  <p>
                    {check.stage === 'input'
                      ? 'Not independently verified. Connect the display and try a hardware control. Input failures appear in recent events.'
                      : check.stage === 'boot'
                        ? 'No running simulator independently confirmed. Use Start & connect, then refresh health after frames arrive.'
                        : check.stage === 'stream'
                          ? 'No decoded frames confirmed. Connect the display, then refresh health.'
                          : 'Not confirmed. Resolve earlier connection checks and refresh health.'}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {report.runtimeCount !== null && report.runtimeCount !== undefined && (
            <p className="field-hint">
              {report.runtimeCount} available iOS runtime{report.runtimeCount === 1 ? '' : 's'} on
              the Mac.
            </p>
          )}
          <details className="recent-events">
            <summary>Recent events ({report.events.length})</summary>
            {report.events.length ? (
              <ol>
                {report.events
                  .slice()
                  .reverse()
                  .map((event, index) => (
                    <li key={index}>
                      <time>{new Date(event.at).toLocaleTimeString()}</time>{' '}
                      {stageLabels[event.stage]}: {event.state}
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="field-hint">
                No recorded events for this Mac in this app session. Host terminal logs are not
                collected.
              </p>
            )}
          </details>
        </>
      )}
      {review && reviewed && (
        <>
          <p className="field-hint">
            Only the report below will be saved. Addresses, names, credentials, certificate
            material, commands, and raw logs are excluded. Nothing is uploaded.
          </p>
          {report?.host && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeHost}
                onChange={(e) => {
                  setIncludeHost(e.target.checked);
                  setSaved(false);
                }}
              />
              Include host version and runtime count
            </label>
          )}
          {!!report?.events.length && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeEvents}
                onChange={(e) => {
                  setIncludeEvents(e.target.checked);
                  setSaved(false);
                }}
              />
              Include recent stage and outcome events
            </label>
          )}
          <pre className="report-preview" tabIndex={0} aria-label="Exact diagnostic report to save">
            {serializeReport(reviewed)}
          </pre>
          {saved && (
            <p role="status" className="saved-report">
              <Check size={16} />{' '}
              {api?.platform === 'web'
                ? 'Diagnostic report download started'
                : 'Diagnostic report saved'}
            </p>
          )}
        </>
      )}
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={busy}
          onClick={review ? () => setReview(false) : refresh}
        >
          {busy ? (
            <Busy text="Checking health…" />
          ) : review ? (
            'Back to health'
          ) : (
            <>
              <RefreshCw size={15} />
              Refresh health
            </>
          )}
        </button>
        {review ? (
          <button
            className="button primary"
            disabled={busy || !api?.exportDiagnostics || demo}
            onClick={async () => {
              if (!reviewed) return;
              setBusy(true);
              setError('');
              try {
                setSaved(await api!.exportDiagnostics!(reviewed));
              } catch {
                setError('The report could not be saved. Choose a writable folder and try again.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <ArrowDownToLine size={15} />
            Save report…
          </button>
        ) : (
          <button
            className="button primary"
            disabled={!report || busy}
            onClick={() => setReview(true)}
          >
            <Activity size={15} />
            Review report
          </button>
        )}
      </div>
      {review && (demo || !api?.exportDiagnostics) && (
        <p className="field-hint">
          Saving reports requires the desktop app with diagnostics support.
        </p>
      )}
    </Modal>
  );
}
