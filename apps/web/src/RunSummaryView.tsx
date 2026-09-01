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

const SOURCE_LINK: Record<string, string> = {
  'scpa-cama': 'County file',
  'fdor-centroids': 'State map',
  'permit-census': 'County permit site',
  'permit-status': 'Permit status site',
  'dbpr-licences': 'State licence file',
  'bbb-ratings': 'bbb.org',
  'overture-places': 'Overture Maps',
};

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

      <QueryAccessPanel ipfs={summary.ipfs} />

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
  const sliced = pageSlice(ordered, page, 20);

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
              <th scope="col">Kind</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Records</th>
              <th scope="col">Collected</th>
              <th scope="col">Where it comes from</th>
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
                  <a
                    className="source-provenance"
                    href={source.provenance}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="source-provenance"
                  >
                    {SOURCE_LINK[source.id] ?? 'Open source'}
                  </a>
                  <span className="cell-sub">{source.cadence}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sliced.pageCount > 1 && (
        <Pagination
          page={sliced.page}
          pageCount={sliced.pageCount}
          onPage={setPage}
          label="Sources pagination"
          testId="sources-pagination"
        />
      )}
    </article>
  );
}

const MCP_DOCS_URL =
  'https://github.com/utkuozdil/oracle-property-intelligence-platform-pipeline-seminole-fl/blob/feat/seminole-pipeline/docs/seminole-mcp-access.md';

const FILEBASE_GATEWAY = 'https://ipfs.filebase.io';

/** Public gateways we show in the UI. `*.ipns.inbrowser.link` is gone (HTTP 410). */
function filebaseUrl(url: string): string {
  const inbrowser = /^https:\/\/([a-z0-9]+)\.ipns\.inbrowser\.link\/?/i.exec(url);
  if (inbrowser !== null) {
    return `${FILEBASE_GATEWAY}/ipns/${inbrowser[1]}/`;
  }
  return url.replace(/^https:\/\/ipfs\.io(?=\/)/, FILEBASE_GATEWAY);
}

function ipnsFolderUrl(ipnsName: string): string {
  return `${FILEBASE_GATEWAY}/ipns/${ipnsName}/`;
}

function queryTableUrl(ipfs: SummaryResponse['ipfs']): string | null {
  const named = ipfs.datasets.find((dataset) => dataset.name === 'query-table');
  if (named !== undefined) return filebaseUrl(named.url);
  if (ipfs.ipnsName !== null) {
    return `${ipnsFolderUrl(ipfs.ipnsName)}query-table/seminole.parquet`;
  }
  if (ipfs.ipnsUrl !== null) {
    return `${filebaseUrl(ipfs.ipnsUrl).replace(/\/$/, '')}/query-table/seminole.parquet`;
  }
  return null;
}

function duckdbSnippet(parquetUrl: string): string {
  return [
    'INSTALL httpfs;',
    'LOAD httpfs;',
    `CREATE VIEW properties AS SELECT * FROM read_parquet('${parquetUrl}');`,
    'SELECT count(*) AS properties, count_if(roof_age > 15) AS roofs_over_15',
    'FROM properties;',
  ].join('\n');
}

/**
 * The demo transcript opens DuckDB and MCP after IPFS. Neither is hosted: this panel
 * points at the published Parquet and at the stdio MCP server that reads the same file.
 */
function QueryAccessPanel({ ipfs }: { ipfs: SummaryResponse['ipfs'] }) {
  const parquetUrl = queryTableUrl(ipfs);
  const sql = parquetUrl === null ? null : duckdbSnippet(parquetUrl);

  return (
    <article className="panel panel--wide" data-testid="query-access-panel">
      <h2>Query without a hosted database</h2>
      <p className="panel-lede">
        The published table is a Parquet file on IPFS. DuckDB and MCP read that file
        directly — nothing stays running here between queries.
      </p>

      <h3 className="panel-subhead">DuckDB</h3>
      {sql === null || parquetUrl === null ? (
        <p className="notice" data-testid="duckdb-absent">
          The query-table CID is not on this run yet. After IPFS publish, this block
          shows the SQL that opens it.
        </p>
      ) : (
        <>
          <p className="panel-lede">
            Paste into the DuckDB CLI. Same command as <code>just duckdb-demo</code>.
          </p>
          <p className="panel-lede">
            Table:{' '}
            <a
              className="link mono"
              href={parquetUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="duckdb-parquet-url"
            >
              {parquetUrl}
            </a>
          </p>
          <pre className="query-snippet" data-testid="duckdb-sql">
            <code>{sql}</code>
          </pre>
        </>
      )}

      <h3 className="panel-subhead">MCP — agent access</h3>
      <p className="panel-lede">
        Agents talk to the same table over MCP. Each consumer runs their own server
        against this IPNS name. Tools: <code>describe_dataset</code>,{' '}
        <code>get_property</code>, <code>search_properties</code>,{' '}
        <code>search_properties_near</code>, <code>find_roofing_leads</code>.
        With bucket credentials, <code>find_roofing_leads</code> reads the published
        permit snapshot — confirmed-open roofing only; <code>unknown</code> is not open.
      </p>
      <p className="panel-lede">
        <a
          className="link"
          href={MCP_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="mcp-docs-link"
        >
          MCP access guide
        </a>
        {' · '}
        <code>just mcp-serve</code>
        {' · '}
        <code>just mcp-probe</code>
      </p>
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

      {ipfs.ipnsName !== null && (
        <p className="panel-lede">
          Browse the published folder:{' '}
          <a
            className="link"
            href={ipnsFolderUrl(ipfs.ipnsName)}
            target="_blank"
            rel="noreferrer"
            data-testid="ipfs-ipns-link"
          >
            {ipnsFolderUrl(ipfs.ipnsName)}
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
                        href={filebaseUrl(dataset.url)}
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
