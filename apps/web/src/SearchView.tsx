import { useEffect, useState } from 'react';
import type { api } from './api';
import {
  MISSING,
  formatCount,
  formatCurrency,
  formatDate,
  formatNumber,
  formatYear,
} from './format';
import {
  EMPTY_QUERY,
  PAGE_SIZES,
  SORT_OPTIONS,
  describeFilters,
  type SearchQuery,
  type SortKey,
} from './query';

type SearchResponse = Awaited<ReturnType<typeof api.parcels.search.query>>;
type MetaResponse = Awaited<ReturnType<typeof api.parcels.meta.query>>;
type ParcelRow = SearchResponse['rows'][number];

export type SearchState =
  | { status: 'loading' }
  | { status: 'ready'; result: SearchResponse }
  | { status: 'error'; message: string };

export interface SearchViewProps {
  /** The query the current results were produced from. Drives the applied-filter chips. */
  applied: SearchQuery;
  meta: MetaResponse | null;
  search: SearchState;
  onApply: (next: SearchQuery) => void;
  onOpenParcel: (parcelId: string) => void;
  /** Opens the owner entity view, which is the other half of the parcel↔owner edge. */
  onOpenOwner: (owner: string) => void;
}

export function SearchView({
  applied,
  meta,
  search,
  onApply,
  onOpenParcel,
  onOpenOwner,
}: SearchViewProps) {
  // The form edits a draft; nothing is queried until Apply, so a half-typed filter never
  // fires a request. Sort and pagination bypass the draft and apply immediately.
  const [draft, setDraft] = useState<SearchQuery>(applied);
  useEffect(() => setDraft(applied), [applied]);

  const set = <K extends keyof SearchQuery>(key: K, value: SearchQuery[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const chips = describeFilters(applied);

  return (
    <>
      <form
        className="filters"
        data-testid="filter-form"
        aria-label="Parcel filters"
        onSubmit={(event) => {
          event.preventDefault();
          onApply({ ...draft, page: 1 });
        }}
      >
        <div className="filter-grid">
          <div className="filter filter--wide">
            <label htmlFor="filter-q">Search parcel ID, owner or address</label>
            <input
              id="filter-q"
              data-testid="search-input"
              type="search"
              placeholder="e.g. SMITH, 629 EDEN PARK RD, 1721295BG0000072A"
              value={draft.q}
              onChange={(event) => set('q', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="filter-jurisdiction">Jurisdiction</label>
            <select
              id="filter-jurisdiction"
              data-testid="filter-jurisdiction"
              value={draft.jurisdiction}
              onChange={(event) => set('jurisdiction', event.target.value)}
            >
              <option value="">All jurisdictions</option>
              {(meta?.jurisdictions ?? []).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.value} ({formatCount(entry.count)})
                </option>
              ))}
            </select>
          </div>

          <div className="filter">
            <label htmlFor="filter-roof-age-min">Roof age minimum (years)</label>
            <input
              id="filter-roof-age-min"
              data-testid="filter-roof-age-min"
              type="number"
              min={0}
              placeholder="Any"
              value={draft.roofAgeMin}
              onChange={(event) => set('roofAgeMin', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="filter-just-value-min">Just value minimum ($)</label>
            <input
              id="filter-just-value-min"
              data-testid="filter-just-value-min"
              type="number"
              min={0}
              placeholder="Any"
              value={draft.justValueMin}
              onChange={(event) => set('justValueMin', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="filter-just-value-max">Just value maximum ($)</label>
            <input
              id="filter-just-value-max"
              data-testid="filter-just-value-max"
              type="number"
              min={0}
              placeholder="Any"
              value={draft.justValueMax}
              onChange={(event) => set('justValueMax', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="filter-year-built-min">Year built from</label>
            <input
              id="filter-year-built-min"
              data-testid="filter-year-built-min"
              type="number"
              min={1500}
              max={2100}
              placeholder="Any"
              value={draft.yearBuiltMin}
              onChange={(event) => set('yearBuiltMin', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="filter-year-built-max">Year built to</label>
            <input
              id="filter-year-built-max"
              data-testid="filter-year-built-max"
              type="number"
              min={1500}
              max={2100}
              placeholder="Any"
              value={draft.yearBuiltMax}
              onChange={(event) => set('yearBuiltMax', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="filter-years-since-sale-min">Years since sale minimum</label>
            <input
              id="filter-years-since-sale-min"
              data-testid="filter-years-since-sale-min"
              type="number"
              min={0}
              placeholder="Any"
              value={draft.yearsSinceSaleMin}
              onChange={(event) => set('yearsSinceSaleMin', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="filter-owner-out-of-area">Owner location</label>
            <select
              id="filter-owner-out-of-area"
              data-testid="filter-owner-out-of-area"
              value={draft.ownerOutOfArea}
              onChange={(event) =>
                set('ownerOutOfArea', event.target.value as SearchQuery['ownerOutOfArea'])
              }
            >
              <option value="">Any owner location</option>
              <option value="true">Out of area only</option>
              <option value="false">In area only</option>
            </select>
          </div>
        </div>

        <div className="filter-actions">
          <button className="button button--primary" type="submit" data-testid="apply-filters">
            Apply filters
          </button>
          <button
            className="button button--ghost"
            type="button"
            data-testid="reset-filters"
            onClick={() => onApply({ ...EMPTY_QUERY, pageSize: applied.pageSize })}
          >
            Reset filters
          </button>
        </div>

        <p className="footnote">
          Roof age is derived from <code>max_effective_year_blt</code>, not <code>year_built</code>,
          and is null for parcels with no building — those parcels are excluded whenever a roof age
          minimum is set.
        </p>
      </form>

      <section className="results" aria-labelledby="results-heading">
        <header className="results-head">
          <h2 id="results-heading">Results</h2>
          <div className="results-meta">
            <strong data-testid="results-total">
              {search.status === 'ready' ? formatCount(search.result.total) : '…'}
            </strong>
            <span> matching parcels</span>
            {search.status === 'ready' && (
              <span className="muted" data-testid="results-took">
                {' '}
                · {search.result.tookMs} ms
              </span>
            )}
          </div>
          <div className="results-controls">
            <label htmlFor="sort-select" className="inline-label">
              Sort by
            </label>
            <select
              id="sort-select"
              data-testid="sort-select"
              value={applied.sort}
              onChange={(event) =>
                onApply({ ...applied, sort: event.target.value as SortKey, page: 1 })
              }
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <label htmlFor="page-size-select" className="inline-label">
              Per page
            </label>
            <select
              id="page-size-select"
              data-testid="page-size-select"
              value={applied.pageSize}
              onChange={(event) =>
                onApply({ ...applied, pageSize: Number(event.target.value), page: 1 })
              }
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="chips" data-testid="active-filters">
          {chips.length === 0 ? (
            <span className="chip chip--muted" data-testid="active-filter-none">
              No filters applied — all {meta ? formatCount(meta.parcelCount) : ''} parcels
            </span>
          ) : (
            chips.map((chip) => (
              <span key={chip.key} className="chip" data-testid={`active-filter-${chip.key}`}>
                {chip.label}
              </span>
            ))
          )}
        </div>

        {search.status === 'loading' && (
          <p className="notice" data-testid="results-loading">
            Querying the snapshot…
          </p>
        )}

        {search.status === 'error' && (
          <p className="notice notice--error" data-testid="results-error">
            Search failed: {search.message}
          </p>
        )}

        {search.status === 'ready' && search.result.total === 0 && (
          <p className="notice" data-testid="results-empty">
            No parcels match these filters.
          </p>
        )}

        {search.status === 'ready' && search.result.total > 0 && (
          <>
            <div className="table-wrap">
              <table className="table" data-testid="results-table">
                <caption className="sr-only">
                  Parcels matching the applied filters, page {search.result.page} of{' '}
                  {search.result.pageCount}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Parcel</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Jurisdiction</th>
                    <th scope="col">Year built</th>
                    <th scope="col">Roof age</th>
                    <th scope="col">Just value</th>
                    <th scope="col">Last sale</th>
                    <th scope="col">Yrs since sale</th>
                  </tr>
                </thead>
                <tbody>
                  {search.result.rows.map((row) => (
                    <ResultRow
                      key={row.parcelId}
                      row={row}
                      onOpen={onOpenParcel}
                      onOpenOwner={onOpenOwner}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <nav className="pagination" aria-label="Results pagination">
              <button
                className="button"
                type="button"
                data-testid="pagination-prev"
                disabled={search.result.page <= 1}
                onClick={() => onApply({ ...applied, page: search.result.page - 1 })}
              >
                Previous page
              </button>
              <span data-testid="pagination-status">
                Page {formatCount(search.result.page)} of {formatCount(search.result.pageCount)}
              </span>
              <button
                className="button"
                type="button"
                data-testid="pagination-next"
                disabled={search.result.page >= search.result.pageCount}
                onClick={() => onApply({ ...applied, page: search.result.page + 1 })}
              >
                Next page
              </button>
            </nav>
          </>
        )}

        {meta && (
          <p className="footnote" data-testid="coverage-note">
            {formatCount(meta.parcelsWithoutAddress)} of {formatCount(meta.parcelCount)} parcels
            carry no situs address in this snapshot. Those rows are titled{' '}
            <code>Parcel &lt;parcel_id&gt;</code> rather than left blank.
          </p>
        )}
      </section>
    </>
  );
}

function ResultRow({
  row,
  onOpen,
  onOpenOwner,
}: {
  row: ParcelRow;
  onOpen: (parcelId: string) => void;
  onOpenOwner: (owner: string) => void;
}) {
  return (
    <tr data-testid="result-row" data-parcel-id={row.parcelId}>
      <td>
        <button
          type="button"
          className="link"
          data-testid="parcel-link"
          data-parcel-id={row.parcelId}
          onClick={() => onOpen(row.parcelId)}
        >
          {row.displayTitle}
        </button>
        <span className="row-sub">
          {row.parcelId}
          {!row.hasAddress && <span className="tag tag--warn">no address</span>}
        </span>
      </td>
      <td data-testid="cell-owner">
        {row.ownerName === null ? (
          MISSING
        ) : (
          <button
            type="button"
            className="link"
            data-testid="owner-link"
            data-owner={row.ownerName}
            onClick={() => onOpenOwner(row.ownerName as string)}
          >
            {row.ownerName}
          </button>
        )}
      </td>
      <td data-testid="cell-jurisdiction">{row.jurisdiction ?? MISSING}</td>
      <td className="num" data-testid="cell-year-built">
        {formatYear(row.yearBuilt)}
      </td>
      <td className="num" data-testid="cell-roof-age">
        {formatNumber(row.roofAge)}
      </td>
      <td className="num" data-testid="cell-just-value">
        {formatCurrency(row.totalJustValue)}
      </td>
      <td className="num" data-testid="cell-last-sale">
        {formatDate(row.lastSaleDate)}
      </td>
      <td className="num" data-testid="cell-years-since-sale">
        {formatNumber(row.yearsSinceSale)}
      </td>
    </tr>
  );
}
