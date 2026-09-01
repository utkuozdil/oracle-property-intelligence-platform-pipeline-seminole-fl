import { useEffect, useState, type ReactNode } from 'react';
import { Pagination, pageSlice } from './Pagination';
import { api } from './api';
import {
  MISSING,
  formatCount,
  formatCurrency,
  formatNumber,
  formatTimestamp,
  formatYear,
} from './format';

type OwnerResponse = Awaited<ReturnType<typeof api.entities.owner.query>>;
type OwnerProfile = NonNullable<OwnerResponse['owner']>;

function PagedPlainList<T>({
  items,
  testId,
  label,
  getKey,
  render,
  empty,
}: {
  items: readonly T[];
  testId: string;
  label: string;
  getKey: (item: T) => string;
  render: (item: T) => ReactNode;
  empty?: ReactNode;
}) {
  const [page, setPage] = useState(1);
  const sliced = pageSlice(items, page);

  return (
    <>
      <ul className="plain-list" data-testid={testId}>
        {items.length === 0 && empty !== undefined && <li>{empty}</li>}
        {sliced.rows.map((item) => (
          <li key={getKey(item)}>{render(item)}</li>
        ))}
      </ul>
      {items.length > 0 && (
        <Pagination
          page={sliced.page}
          pageCount={sliced.pageCount}
          onPage={setPage}
          label={label}
          testId={`${testId}-pagination`}
        />
      )}
    </>
  );
}

type OwnerState =
  | { status: 'loading' }
  | { status: 'ready'; response: OwnerResponse; owner: OwnerProfile }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export interface OwnerDetailViewProps {
  owner: string;
  onBack: () => void;
  onOpenParcel: (parcelId: string) => void;
  onOpenRadius: (near: string) => void;
}

export function OwnerDetailView({
  owner,
  onBack,
  onOpenParcel,
  onOpenRadius,
}: OwnerDetailViewProps) {
  const [state, setState] = useState<OwnerState>({ status: 'loading' });
  const [page, setPage] = useState(1);

  useEffect(() => setPage(1), [owner]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.entities.owner
      .query({ owner, page, pageSize: 25 })
      .then((response) => {
        if (cancelled) return;
        setState(
          response.owner === null
            ? { status: 'missing' }
            : { status: 'ready', response, owner: response.owner },
        );
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
  }, [owner, page]);

  return (
    <section className="detail" data-testid="owner-detail" aria-labelledby="owner-detail-heading">
      <button
        className="button button--ghost"
        type="button"
        onClick={onBack}
        data-testid="back-to-owners"
      >
        ← Back
      </button>

      {state.status === 'loading' && (
        <p className="notice" data-testid="owner-detail-loading">
          Loading owner {owner}…
        </p>
      )}

      {state.status === 'missing' && (
        <p className="notice notice--error" data-testid="owner-detail-missing">
          No owner in this snapshot normalises to “{owner}”.
        </p>
      )}

      {state.status === 'error' && (
        <p className="notice notice--error" data-testid="owner-detail-error">
          Could not load owner {owner}: {state.message}
        </p>
      )}

      {state.status === 'ready' && (
        <>
          <header className="detail-head">
            <h1 id="owner-detail-heading" data-testid="owner-name">
              {state.owner.name}
            </h1>
            <p className="detail-sub">
              Owner entity · key <span className="mono">{state.owner.key}</span>
            </p>
          </header>

          <div className="stat-row">
            <div className="stat">
              <span className="stat-label">Parcels held</span>
              <span className="stat-value" data-testid="owner-parcel-count">
                {formatCount(state.owner.parcelCount)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Total just value</span>
              <span className="stat-value" data-testid="owner-total-value">
                {formatCurrency(state.owner.totalJustValue)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Annual tax</span>
              <span className="stat-value">{formatCurrency(state.owner.totalAnnualTax)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Out-of-area parcels</span>
              <span className="stat-value" data-testid="owner-out-of-area">
                {formatCount(state.owner.outOfAreaParcels)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Homestead parcels</span>
              <span className="stat-value">{formatCount(state.owner.homesteadParcels)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Oldest roof</span>
              <span className="stat-value" data-testid="owner-oldest-roof">
                {state.owner.oldestRoofAge === null
                  ? MISSING
                  : `${formatNumber(state.owner.oldestRoofAge)} yrs`}
              </span>
            </div>
          </div>

          <div className="detail-grid">
            <article className="panel">
              <h2>Mailing</h2>
              <PagedPlainList
                items={state.owner.mailingLocations}
                testId="owner-mailing-list"
                label="Mailing locations pagination"
                getKey={(entry) => entry.value}
                empty={MISSING}
                render={(entry) => (
                  <>
                    {entry.value} <span className="muted">({formatCount(entry.count)})</span>
                  </>
                )}
              />
              {state.owner.mailingStreets.length > 0 && (
                <p className="footnote">Mailing street: {state.owner.mailingStreets.join('; ')}</p>
              )}
            </article>

            <article className="panel">
              <h2>Jurisdictions</h2>
              <PagedPlainList
                items={state.owner.jurisdictions}
                testId="owner-jurisdiction-list"
                label="Jurisdictions pagination"
                getKey={(entry) => entry.value}
                render={(entry) => (
                  <>
                    {entry.value} <span className="muted">({formatCount(entry.count)})</span>
                  </>
                )}
              />
            </article>

            <article className="panel">
              <h2>Name spellings in the roll</h2>
              <PagedPlainList
                items={state.owner.spellings}
                testId="owner-spellings"
                label="Name spellings pagination"
                getKey={(spelling) => spelling}
                render={(spelling) => <span className="mono">{spelling}</span>}
              />
              <p className="footnote">
                {state.owner.spellings.length === 1
                  ? 'One spelling, so no records were merged to form this entity.'
                  : `${state.owner.spellings.length} spellings normalise to this owner. Each is shown so the merge can be audited.`}
              </p>
            </article>
          </div>

          <section className="results" aria-labelledby="owner-parcels-heading">
            <header className="results-head">
              <h2 id="owner-parcels-heading">Parcels held</h2>
              <div className="results-controls">
                <button
                  type="button"
                  className="button"
                  data-testid="owner-open-radius"
                  onClick={() => onOpenRadius(state.owner.parcels[0]?.parcelId ?? state.owner.name)}
                >
                  Search around the largest holding
                </button>
              </div>
            </header>

            <div className="table-wrap">
              <table className="table" data-testid="owner-parcels-table">
                <thead>
                  <tr>
                    <th scope="col">Parcel</th>
                    <th scope="col">Jurisdiction</th>
                    <th scope="col">Year built</th>
                    <th scope="col">Roof age</th>
                    <th scope="col">Just value</th>
                    <th scope="col">Yrs since sale</th>
                  </tr>
                </thead>
                <tbody>
                  {state.owner.parcels.map((parcel) => (
                    <tr
                      key={parcel.parcelId}
                      data-testid="owner-parcel-row"
                      data-parcel-id={parcel.parcelId}
                    >
                      <td>
                        <button
                          type="button"
                          className="link"
                          data-testid="owner-parcel-link"
                          data-parcel-id={parcel.parcelId}
                          onClick={() => onOpenParcel(parcel.parcelId)}
                        >
                          {parcel.displayTitle}
                        </button>
                        <span className="row-sub">{parcel.parcelId}</span>
                      </td>
                      <td>{parcel.jurisdiction ?? MISSING}</td>
                      <td className="num">{formatYear(parcel.yearBuilt)}</td>
                      <td className="num">{formatNumber(parcel.roofAge)}</td>
                      <td className="num">{formatCurrency(parcel.totalJustValue)}</td>
                      <td className="num">{formatNumber(parcel.yearsSinceSale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={state.owner.page}
              pageCount={Math.max(1, state.owner.pageCount)}
              onPage={setPage}
              label="Owner parcels pagination"
              testId="owner-pagination"
            />

            <p className="footnote" data-testid="owner-provenance">
              Source: {state.response.provenance.source} ·{' '}
              <span className="mono">{state.response.provenance.url}</span> · snapshot{' '}
              <code>{state.response.provenance.snapshotRunId}</code> published{' '}
              {formatTimestamp(state.response.provenance.publishedAt)}.
            </p>
          </section>
        </>
      )}
    </section>
  );
}
