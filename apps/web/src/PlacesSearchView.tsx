import { useEffect, useState } from 'react';
import type { api } from './api';
import { MISSING, formatCount, formatNumber } from './format';
import {
  EMPTY_PLACES,
  PAGE_SIZES,
  PLACE_SORT_OPTIONS,
  describePlaceFilters,
  type PlaceSortKey,
  type PlacesQuery,
} from './query';

type SearchResponse = Awaited<ReturnType<typeof api.places.search.query>>;
type MetaResponse = Awaited<ReturnType<typeof api.places.meta.query>>;
type PlaceRow = SearchResponse['rows'][number];

export type PlacesSearchState =
  | { status: 'loading' }
  | { status: 'ready'; result: SearchResponse }
  | { status: 'error'; message: string };

export interface PlacesSearchViewProps {
  applied: PlacesQuery;
  meta: MetaResponse | null;
  search: PlacesSearchState;
  onApply: (next: PlacesQuery) => void;
  onOpenPlace: (gersId: string) => void;
}

export function PlacesSearchView({
  applied,
  meta,
  search,
  onApply,
  onOpenPlace,
}: PlacesSearchViewProps) {
  const [draft, setDraft] = useState<PlacesQuery>(applied);
  useEffect(() => setDraft(applied), [applied]);

  const set = <K extends keyof PlacesQuery>(key: K, value: PlacesQuery[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const chips = describePlaceFilters(applied);

  return (
    <>
      <form
        className="filters"
        data-testid="places-filter-form"
        aria-label="Business filters"
        onSubmit={(event) => {
          event.preventDefault();
          onApply({ ...draft, page: 1 });
        }}
      >
        <div className="filter-grid">
          <div className="filter filter--wide">
            <label htmlFor="places-q">Search name, address or category</label>
            <input
              id="places-q"
              data-testid="places-search-input"
              type="search"
              placeholder="e.g. pizza, roofing, 100 MAIN, Sanford"
              value={draft.q}
              onChange={(event) => set('q', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="places-jurisdiction">Jurisdiction</label>
            <select
              id="places-jurisdiction"
              data-testid="places-filter-jurisdiction"
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
            <label htmlFor="places-category">Category</label>
            <select
              id="places-category"
              data-testid="places-filter-category"
              value={draft.category}
              onChange={(event) => set('category', event.target.value)}
            >
              <option value="">All categories</option>
              {(meta?.categories ?? []).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.value} ({formatCount(entry.count)})
                </option>
              ))}
            </select>
          </div>

          <div className="filter">
            <label htmlFor="places-status">Operating status</label>
            <select
              id="places-status"
              data-testid="places-filter-status"
              value={draft.status}
              onChange={(event) => set('status', event.target.value)}
            >
              <option value="">Any status</option>
              {(meta?.statuses ?? []).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.value} ({formatCount(entry.count)})
                </option>
              ))}
            </select>
          </div>

          <div className="filter">
            <label htmlFor="places-roofing">Trade</label>
            <select
              id="places-roofing"
              data-testid="places-filter-roofing"
              value={draft.roofingOnly}
              onChange={(event) =>
                set('roofingOnly', event.target.value === 'true' ? 'true' : '')
              }
            >
              <option value="">All businesses</option>
              <option value="true">
                Roofing only{meta ? ` (${formatCount(meta.roofingCount)})` : ''}
              </option>
            </select>
          </div>
        </div>

        <div className="filter-actions">
          <button className="button button--primary" type="submit" data-testid="places-apply">
            Apply filters
          </button>
          <button
            className="button button--ghost"
            type="button"
            data-testid="places-reset"
            onClick={() => onApply({ ...EMPTY_PLACES, pageSize: applied.pageSize })}
          >
            Reset filters
          </button>
        </div>

        <p className="footnote">
          These are Overture Maps locations — where a business operates — not legal entities.
          Every clipped county place is kept; confidence is published so you can filter, and is
          never used to drop a row.
        </p>
      </form>

      <section className="results" aria-labelledby="places-results-heading">
        <header className="results-head">
          <h2 id="places-results-heading">Businesses</h2>
          <div className="results-meta">
            <strong data-testid="places-results-total">
              {search.status === 'ready' ? formatCount(search.result.total) : '…'}
            </strong>
            <span> matching places</span>
            {search.status === 'ready' && (
              <span className="muted" data-testid="places-results-took">
                {' '}
                · {search.result.tookMs} ms
              </span>
            )}
          </div>
          <div className="results-controls">
            <label htmlFor="places-sort" className="inline-label">
              Sort by
            </label>
            <select
              id="places-sort"
              data-testid="places-sort-select"
              value={applied.sort}
              onChange={(event) =>
                onApply({ ...applied, sort: event.target.value as PlaceSortKey, page: 1 })
              }
            >
              {PLACE_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <label htmlFor="places-page-size" className="inline-label">
              Per page
            </label>
            <select
              id="places-page-size"
              data-testid="places-page-size-select"
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

        <div className="chips" data-testid="places-active-filters">
          {chips.length === 0 ? (
            <span className="chip chip--muted" data-testid="places-active-filter-none">
              No filters applied — all {meta ? formatCount(meta.placeCount) : ''} places
            </span>
          ) : (
            chips.map((chip) => (
              <span key={chip.key} className="chip" data-testid={`places-active-filter-${chip.key}`}>
                {chip.label}
              </span>
            ))
          )}
        </div>

        {search.status === 'loading' && (
          <p className="notice" data-testid="places-results-loading">
            Querying the places snapshot…
          </p>
        )}

        {search.status === 'error' && (
          <p className="notice notice--error" data-testid="places-results-error">
            Search failed: {search.message}
          </p>
        )}

        {search.status === 'ready' && search.result.total === 0 && (
          <p className="notice" data-testid="places-results-empty">
            No businesses match these filters.
          </p>
        )}

        {search.status === 'ready' && search.result.total > 0 && (
          <>
            <div className="table-wrap">
              <table className="table" data-testid="places-results-table">
                <caption className="sr-only">
                  Businesses matching the applied filters, page {search.result.page} of{' '}
                  {search.result.pageCount}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Business</th>
                    <th scope="col">Category</th>
                    <th scope="col">Jurisdiction</th>
                    <th scope="col">Status</th>
                    <th scope="col">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {search.result.rows.map((row) => (
                    <PlaceRowView key={row.gersId} row={row} onOpen={onOpenPlace} />
                  ))}
                </tbody>
              </table>
            </div>

            <nav className="pagination" aria-label="Business results pagination">
              <button
                className="button"
                type="button"
                data-testid="places-pagination-prev"
                disabled={search.result.page <= 1}
                onClick={() => onApply({ ...applied, page: search.result.page - 1 })}
              >
                Previous page
              </button>
              <span data-testid="places-pagination-status">
                Page {formatCount(search.result.page)} of {formatCount(search.result.pageCount)}
              </span>
              <button
                className="button"
                type="button"
                data-testid="places-pagination-next"
                disabled={search.result.page >= search.result.pageCount}
                onClick={() => onApply({ ...applied, page: search.result.page + 1 })}
              >
                Next page
              </button>
            </nav>
          </>
        )}

        {meta && (
          <p className="footnote" data-testid="places-coverage-note">
            {formatCount(meta.placeCount)} places from Overture release {meta.release}.{' '}
            {formatCount(meta.unnamedCount)} have no published name and are titled{' '}
            <code>Place &lt;gers_id&gt;</code>. This is a clipped county extract, not a census of
            every business that operates here.
          </p>
        )}
      </section>
    </>
  );
}

function PlaceRowView({ row, onOpen }: { row: PlaceRow; onOpen: (gersId: string) => void }) {
  return (
    <tr data-testid="place-row" data-gers-id={row.gersId}>
      <td>
        <button
          type="button"
          className="link"
          data-testid="place-link"
          data-gers-id={row.gersId}
          onClick={() => onOpen(row.gersId)}
        >
          {row.displayTitle}
        </button>
        <span className="row-sub">
          {row.addressFreeform ?? 'No address on record'}
          {row.isRoofing && <span className="tag">roofing</span>}
        </span>
      </td>
      <td data-testid="place-cell-category">{row.basicCategory ?? MISSING}</td>
      <td data-testid="place-cell-jurisdiction">{row.jurisdiction ?? MISSING}</td>
      <td data-testid="place-cell-status">{row.operatingStatus ?? MISSING}</td>
      <td className="num" data-testid="place-cell-confidence">
        {row.confidence === null ? MISSING : formatNumber(Number(row.confidence.toFixed(3)))}
      </td>
    </tr>
  );
}
