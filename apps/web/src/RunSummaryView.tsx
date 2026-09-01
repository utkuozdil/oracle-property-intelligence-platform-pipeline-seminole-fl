import { useEffect, useState } from 'react';
import { Pagination, pageSlice } from './Pagination';
import { api } from './api';
import { MISSING, formatBytes, formatCount, formatTimestamp } from './format';

type SummaryResponse = Awaited<ReturnType<typeof api.runs.summary.query>>;
type SourceEntry = SummaryResponse['sources'][number];
type Limitation = SummaryResponse['limitations'][number];

type State =
  | { status: 'loading' }
  | { status: 'ready'; summary: SummaryResponse }
  | { status: 'error'; message: string };

const STATUS_LABEL: Record<SourceEntry['status'], string> = {
  ingested: 'Ingested',
  'in-progress': 'Ingesting now',
  'not-ingested': 'Not yet ingested',
  declined: 'Deliberately not ingested',
};

const CATEGORY_LABEL: Record<SourceEntry['category'], string> = {
  property: 'Property',
  permit: 'Permit',
  ownership: 'Ownership',
  contractor: 'Contractor',
  business: 'Business',
  coordinate: 'Coordinates',
};

/** Presentation order matches the order the demo transcript asks for them. */
const CATEGORY_ORDER: SourceEntry['category'][] = [
  'property',
  'permit',
  'ownership',
  'contractor',
  'business',
  'coordinate',
];

/**
 * The pipeline run summary the demo opens on: completed run, source list with counts
 * and provenance, IPFS artifacts, then documented limitations.
 */
export function RunSummaryView() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.runs.summary
      .query()
      .then((summary) => {
        if (!cancelled) setState({ status: 'ready', summary });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <p className="notice" data-testid="run-summary-loading">
        Reading run manifests…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p className="notice notice--error" data-testid="run-summary-error">
        Could not read the run manifests: {state.message}
      </p>
    );
  }

  const { summary } = state;
  const current = summary.current;

  return (
    <section
      className="run-summary"
      data-testid="run-summary"
      aria-labelledby="run-summary-heading"
    >
      <header className="detail-head">
        <h1 id="run-summary-heading">Pipeline run summary</h1>
        <p className="detail-sub">
          <span data-testid="run-summary-county">{summary.county}</span>
          {current !== null && (
            <>
              {' '}
              · finished{' '}
              <span data-testid="run-current-finished">
                {formatTimestamp(current.finishedAt)}
              </span>
              {current.parcelCount !== null && (
                <>
                  {' '}
                  ·{' '}
                  <span data-testid="run-current-parcels">
                    {formatCount(current.parcelCount)} parcels
                  </span>
                </>
              )}
            </>
          )}
        </p>
      </header>

      <SourcesPanel sources={summary.sources} />

      <IpfsPanel ipfs={summary.ipfs} />

      <LimitationsPanel limitations={summary.limitations} />
    </section>
  );
}

function InlineField({
  label,
  value,
  testId,
  mono = false,
}: {
  label: string;
  value: string;
  testId: string;
  mono?: boolean;
}) {
  return (
    <div className="inline-field">
      <span className="inline-field-label">{label}</span>
      <span
        className={mono ? 'inline-field-value mono' : 'inline-field-value'}
        data-testid={testId}
      >
        {value}
      </span>
    </div>
  );
}

function SourcesPanel({ sources }: { sources: SourceEntry[] }) {
  const [page, setPage] = useState(1);
  const listed = sources.filter(
    (source) => source.status === 'ingested' || source.status === 'in-progress',
  );
  const ordered = [...listed].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
  const ingested = listed.filter((source) => source.status === 'ingested').length;
  const sliced = pageSlice(ordered, page);

  return (
    <article className="panel panel--wide" data-testid="sources-panel">
      <h2>Uploaded records by source</h2>
      <p className="panel-lede" data-testid="sources-lede">
        {formatCount(ingested)} of {formatCount(listed.length)} sources loaded.
      </p>
      <div className="table-wrap">
        <table className="table" data-testid="sources-table">
          <thead>
            <tr>
              <th scope="col">Record class</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Records</th>
              <th scope="col">Collected</th>
              <th scope="col">Provenance</th>
            </tr>
          </thead>
          <tbody>
            {sliced.rows.map((source) => (
              <tr key={source.id} data-testid="source-row" data-source-id={source.id}>
                <td data-testid="source-category">{CATEGORY_LABEL[source.category]}</td>
                <td>
                  <span className="source-label">{source.label}</span>
                </td>
                <td>
                  <span
                    className={`tag tag--${source.status === 'ingested' ? 'ok' : source.status === 'in-progress' ? 'live' : 'warn'}`}
                    data-testid="source-status"
                    data-status={source.status}
                  >
                    {STATUS_LABEL[source.status]}
                  </span>
                </td>
                <td className="num" data-testid="source-records">
                  {source.records === null ? MISSING : formatCount(source.records)}
                  {source.records !== null && source.recordUnit !== null && (
                    <span className="cell-sub">{source.recordUnit}</span>
                  )}
                </td>
                <td data-testid="source-collected-at">{formatTimestamp(source.collectedAt)}</td>
                <td>
                  <span className="source-provenance mono" data-testid="source-provenance">
                    {source.provenance}
                  </span>
                  <span className="cell-sub">{source.cadence}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={sliced.page}
        pageCount={sliced.pageCount}
        onPage={setPage}
        label="Sources pagination"
        testId="sources-pagination"
      />
    </article>
  );
}

function LimitationsPanel({ limitations }: { limitations: Limitation[] }) {
  const [page, setPage] = useState(1);
  const sliced = pageSlice(limitations, page);

  return (
    <article className="panel panel--wide" data-testid="limitations-panel">
      <h2>Documented source limitations</h2>
      <ul className="limitations" data-testid="limitations-list">
        {sliced.rows.map((limitation) => (
          <li key={limitation.id} data-testid="limitation-item" data-limitation-id={limitation.id}>
            <span className="limitation-scope">{limitation.scope}</span>
            <span className="limitation-text">{limitation.text}</span>
          </li>
        ))}
      </ul>
      {sliced.pageCount > 1 ? (
        <Pagination
          page={sliced.page}
          pageCount={sliced.pageCount}
          onPage={setPage}
          label="Limitations pagination"
          testId="limitations-pagination"
        />
      ) : null}
    </article>
  );
}

function IpfsPanel({ ipfs }: { ipfs: SummaryResponse['ipfs'] }) {
  const [page, setPage] = useState(1);
  const sliced = pageSlice(ipfs.datasets, page);

  if (!ipfs.present) {
    return (
      <article className="panel" data-testid="ipfs-panel">
        <h2>IPFS artifacts</h2>
        <p className="notice" data-testid="ipfs-absent">
          Not published yet.
        </p>
      </article>
    );
  }

  return (
    <article className="panel panel--wide" data-testid="ipfs-panel">
      <h2>IPFS artifacts</h2>
      <div className="inline-fields">
        {ipfs.ipnsName !== null && (
          <InlineField label="IPNS name" value={ipfs.ipnsName} testId="ipfs-ipns-name" mono />
        )}
        {ipfs.rootCid !== null && (
          <InlineField label="Root CID" value={ipfs.rootCid} testId="ipfs-root-cid" mono />
        )}
        <InlineField
          label="Published"
          value={formatTimestamp(ipfs.publishedAt)}
          testId="ipfs-published-at"
        />
        {ipfs.totals !== null && (
          <InlineField
            label="Total published"
            value={`${formatBytes(ipfs.totals.bytes)}${ipfs.totals.files === null ? '' : ` in ${formatCount(ipfs.totals.files)} files`}`}
            testId="ipfs-totals"
          />
        )}
      </div>

      {ipfs.ipnsUrl !== null && (
        <p className="panel-lede">
          <a
            className="link"
            href={ipfs.ipnsUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="ipfs-ipns-link"
          >
            {ipfs.ipnsUrl}
          </a>
        </p>
      )}

      {ipfs.datasets.length > 0 && (
        <>
          <div className="table-wrap table-wrap--tight">
            <table className="table" data-testid="ipfs-datasets-table">
              <thead>
                <tr>
                  <th scope="col">Dataset</th>
                  <th scope="col">CID</th>
                  <th scope="col">Size</th>
                  <th scope="col">Files</th>
                  <th scope="col">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {sliced.rows.map((dataset) => (
                  <tr key={dataset.cid} data-testid="ipfs-dataset-row" data-dataset={dataset.name}>
                    <td>{dataset.name}</td>
                    <td>
                      <a
                        className="link mono"
                        href={dataset.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="ipfs-cid"
                      >
                        {dataset.cid}
                      </a>
                      {dataset.entryPath !== null && (
                        <span className="cell-sub">{dataset.entryPath}</span>
                      )}
                    </td>
                    <td className="num">{formatBytes(dataset.bytes)}</td>
                    <td className="num">
                      {dataset.files === null ? MISSING : formatCount(dataset.files)}
                    </td>
                    <td data-testid="ipfs-coverage">{dataset.coverage ?? MISSING}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={sliced.page}
            pageCount={sliced.pageCount}
            onPage={setPage}
            label="IPFS datasets pagination"
            testId="ipfs-pagination"
          />
        </>
      )}
    </article>
  );
}
