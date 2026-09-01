import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

type Health = Awaited<ReturnType<typeof api.system.health.query>>;
type Readiness = Awaited<ReturnType<typeof api.system.readiness.query>>;

interface Probe {
  health: Health;
  readiness: Readiness;
}

type ProbeState =
  { status: 'loading' } | { status: 'ready'; probe: Probe } | { status: 'error'; message: string };

/** Surfaces the pipeline will grow into. Rendered disabled so the shape of the work is visible. */
const PLANNED_SECTIONS = [
  { name: 'Run history', detail: 'Per-run source list, record counts, deltas and timestamps' },
  { name: 'Sources', detail: 'Source inventory with throughput limits and constraints' },
  { name: 'Parcels', detail: 'Per-parcel stage status across appraisal and permits' },
  { name: 'Permits', detail: 'Roofing permits with open duration and contractor identity' },
  { name: 'IPFS artifacts', detail: 'Published CIDs and the IPNS pointer per run' },
  { name: 'Query layer', detail: 'DuckDB query table and the MCP interface over it' },
];

export function App() {
  const [state, setState] = useState<ProbeState>({ status: 'loading' });

  const runProbe = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [health, readiness] = await Promise.all([
        api.system.health.query(),
        api.system.readiness.query(),
      ]);
      setState({ status: 'ready', probe: { health, readiness } });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Oracle Seminole</span>
        </div>
        <nav>
          <button className="nav-item nav-item--active" type="button">
            Platform status
          </button>
          {PLANNED_SECTIONS.map((section) => (
            <button key={section.name} className="nav-item" type="button" disabled>
              {section.name}
            </button>
          ))}
        </nav>
        <p className="sidebar-foot">Phase 0 — infrastructure only</p>
      </aside>

      <main className="content">
        <header className="content-head">
          <div>
            <h1>Platform status</h1>
            <p>
              This deployment provisions the pipeline&apos;s infrastructure and proves the request
              path end to end. Ingestion, reconciliation and IPFS publication arrive in later
              phases.
            </p>
          </div>
          <button className="refresh" type="button" onClick={() => void runProbe()}>
            Re-run checks
          </button>
        </header>

        <section className="cards">
          {state.status === 'loading' && <article className="card">Checking the API…</article>}

          {state.status === 'error' && (
            <article className="card card--error">
              <h2>API unreachable</h2>
              <p className="mono">{state.message}</p>
            </article>
          )}

          {state.status === 'ready' && (
            <>
              <article className="card">
                <h2>
                  API<span className="pill pill--ok">{state.probe.health.status}</span>
                </h2>
                <dl>
                  <dt>Service</dt>
                  <dd className="mono">{state.probe.health.service}</dd>
                  <dt>County</dt>
                  <dd className="mono">{state.probe.health.county}</dd>
                  <dt>Region</dt>
                  <dd className="mono">{state.probe.health.region}</dd>
                  <dt>Checked</dt>
                  <dd className="mono">{state.probe.health.checkedAt}</dd>
                </dl>
              </article>

              <article className="card">
                <h2>
                  DynamoDB
                  <span
                    className={`pill ${
                      state.probe.readiness.dependencies.dynamodb === 'reachable'
                        ? 'pill--ok'
                        : 'pill--bad'
                    }`}
                  >
                    {state.probe.readiness.dependencies.dynamodb}
                  </span>
                </h2>
                <p>
                  Single-table store keyed <code>RUN#</code>, <code>SOURCE#</code>,{' '}
                  <code>PARCEL#</code>, <code>ELIG#</code> and <code>CID#</code>.
                </p>
              </article>

              <article className="card">
                <h2>
                  Data lake
                  <span
                    className={`pill ${
                      state.probe.readiness.dependencies.dataBucket === 'reachable'
                        ? 'pill--ok'
                        : 'pill--bad'
                    }`}
                  >
                    {state.probe.readiness.dependencies.dataBucket}
                  </span>
                </h2>
                <dl>
                  {state.probe.readiness.prefixes.map((prefix) => (
                    <div key={prefix.prefix} className="prefix-row">
                      <dt className="mono">{prefix.prefix}</dt>
                      <dd className="mono">{prefix.objectCount} objects</dd>
                    </div>
                  ))}
                </dl>
              </article>
            </>
          )}
        </section>

        <section className="planned">
          <h2>Planned surfaces</h2>
          <ul>
            {PLANNED_SECTIONS.map((section) => (
              <li key={section.name}>
                <strong>{section.name}</strong>
                <span>{section.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
