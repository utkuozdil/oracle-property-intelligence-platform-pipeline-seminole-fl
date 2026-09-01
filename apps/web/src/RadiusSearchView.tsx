import { useEffect, useState } from 'react';
import type { api } from './api';
import {
  MISSING,
  formatCoordinate,
  formatCount,
  formatCurrency,
  formatMiles,
  formatNumber,
  formatYear,
} from './format';
import {
  EMPTY_RADIUS,
  NEARBY_SORT_OPTIONS,
  RADIUS_MILE_PRESETS,
  type NearbySortKey,
  type RadiusQuery,
} from './query';

type NearbyResponse = Awaited<ReturnType<typeof api.parcels.nearby.query>>;
type MetaResponse = Awaited<ReturnType<typeof api.parcels.meta.query>>;
type ResolvedResponse = Extract<NearbyResponse, { resolved: true }>;

export type RadiusState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: NearbyResponse }
  | { status: 'error'; message: string };

export interface RadiusSearchViewProps {
  applied: RadiusQuery;
  meta: MetaResponse | null;
  state: RadiusState;
  onApply: (next: RadiusQuery) => void;
  onOpenParcel: (parcelId: string) => void;
  onOpenOwner: (owner: string) => void;
}

/**
 * Radius search around a GPS point or a place resolved from the county roll.
 *
 * Every control here is a real input or button: a centre can be typed as text or as a
 * latitude/longitude pair, and the radius can be typed or taken from a preset. Nothing
 * requires dragging a map, so the whole capability is reachable from the keyboard and from
 * an automated browser.
 */
export function RadiusSearchView({
  applied,
  meta,
  state,
  onApply,
  onOpenParcel,
  onOpenOwner,
}: RadiusSearchViewProps) {
  const [draft, setDraft] = useState<RadiusQuery>(applied);
  useEffect(() => setDraft(applied), [applied]);

  const set = <K extends keyof RadiusQuery>(key: K, value: RadiusQuery[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className="radius" data-testid="radius-view" aria-labelledby="radius-heading">
      <header className="detail-head">
        <h1 id="radius-heading">Radius search</h1>
        <p className="detail-sub">
          {meta === null
            ? 'Loading coverage…'
            : `${formatCount(meta.parcelsWithCoordinates)} of ${formatCount(meta.parcelCount)} parcels carry a centroid and are searchable by radius`}
        </p>
      </header>

      <form
        className="filters"
        data-testid="radius-form"
        aria-label="Radius search"
        onSubmit={(event) => {
          event.preventDefault();
          onApply({ ...draft, page: 1 });
        }}
      >
        <div className="filter-grid">
          <div className="filter filter--wide">
            <label htmlFor="radius-near">Centre — address, parcel ID, jurisdiction, or owner</label>
            <input
              id="radius-near"
              data-testid="radius-near-input"
              type="search"
              placeholder="e.g. Sanford, 629 EDEN PARK RD, or 1721295BG0000072A"
              value={draft.near}
              onChange={(event) => set('near', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="radius-lat">Latitude (GPS pin)</label>
            <input
              id="radius-lat"
              data-testid="radius-lat-input"
              type="number"
              step="any"
              placeholder="28.8029"
              value={draft.lat}
              onChange={(event) => set('lat', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="radius-lon">Longitude (GPS pin)</label>
            <input
              id="radius-lon"
              data-testid="radius-lon-input"
              type="number"
              step="any"
              placeholder="-81.2695"
              value={draft.lon}
              onChange={(event) => set('lon', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="radius-miles">Radius (miles)</label>
            <input
              id="radius-miles"
              data-testid="radius-miles-input"
              type="number"
              min={0.05}
              max={50}
              step="any"
              value={draft.radiusMiles}
              onChange={(event) => set('radiusMiles', event.target.value)}
            />
            <div className="preset-row">
              {RADIUS_MILE_PRESETS.map((miles) => (
                <button
                  key={miles}
                  type="button"
                  className="button button--chip"
                  data-testid={`radius-miles-${String(miles).replace('.', '-')}`}
                  onClick={() => onApply({ ...draft, radiusMiles: String(miles), page: 1 })}
                >
                  {miles} mi
                </button>
              ))}
            </div>
          </div>

          <div className="filter">
            <label htmlFor="radius-roof-age-min">Roof age minimum (years)</label>
            <input
              id="radius-roof-age-min"
              data-testid="radius-roof-age-min"
              type="number"
              min={0}
              placeholder="Any"
              value={draft.roofAgeMin}
              onChange={(event) => set('roofAgeMin', event.target.value)}
            />
          </div>

          <div className="filter">
            <label htmlFor="radius-jurisdiction">Jurisdiction</label>
            <select
              id="radius-jurisdiction"
              data-testid="radius-jurisdiction"
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
            <label htmlFor="radius-owner-out-of-area">Owner location</label>
            <select
              id="radius-owner-out-of-area"
              data-testid="radius-owner-out-of-area"
              value={draft.ownerOutOfArea}
              onChange={(event) =>
                set('ownerOutOfArea', event.target.value as RadiusQuery['ownerOutOfArea'])
              }
            >
              <option value="">Any owner location</option>
              <option value="true">Out of area only</option>
              <option value="false">In area only</option>
            </select>
          </div>
        </div>

        <div className="filter-actions">
          <button
            className="button button--primary"
            type="submit"
            data-testid="radius-submit"
            onClick={(event) => {
              event.preventDefault();
              onApply({ ...draft, page: 1 });
            }}
          >
            Search this radius
          </button>
          <button
            className="button button--ghost"
            type="button"
            data-testid="radius-reset"
            onClick={() => onApply({ ...EMPTY_RADIUS, pageSize: applied.pageSize })}
          >
            Reset
          </button>
        </div>

        <p className="footnote">
          Coordinates win over text when both are filled, so a pin drop is never overridden.
          Distance is exact haversine; a latitude/longitude bounding box sized to the radius decides
          which parcels get a distance computed at all.
        </p>
      </form>

      <RadiusResults
        state={state}
        applied={applied}
        onApply={onApply}
        onOpenParcel={onOpenParcel}
        onOpenOwner={onOpenOwner}
      />
    </section>
  );
}

function RadiusResults({
  state,
  applied,
  onApply,
  onOpenParcel,
  onOpenOwner,
}: {
  state: RadiusState;
  applied: RadiusQuery;
  onApply: (next: RadiusQuery) => void;
  onOpenParcel: (parcelId: string) => void;
  onOpenOwner: (owner: string) => void;
}) {
  if (state.status === 'idle') {
    return null;
  }

  if (state.status === 'loading') {
    return (
      <p className="notice" data-testid="radius-loading">
        Searching the snapshot…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p className="notice notice--error" data-testid="radius-error">
        Radius search failed: {state.message}
      </p>
    );
  }

  if (!state.result.resolved) {
    return (
      <p className="notice notice--error" data-testid="radius-unresolved">
        No parcel, address, owner, or jurisdiction in this snapshot matches “
        {state.result.near ?? ''}”, so there is no centre to search around. Try a jurisdiction name
        such as Sanford, or enter a latitude and longitude directly.
      </p>
    );
  }

  const result: ResolvedResponse = state.result;

  return (
    <section className="results" aria-labelledby="radius-results-heading">
      <header className="results-head">
        <h2 id="radius-results-heading">Results</h2>
        <div className="results-meta">
          <strong data-testid="radius-results-total">{formatCount(result.total)}</strong>
          <span> parcels within {formatMiles(result.radiusMiles)}</span>
          <span className="muted" data-testid="radius-took">
            {' '}
            · {result.tookMs} ms
          </span>
        </div>
        <div className="results-controls">
          <label htmlFor="radius-sort" className="inline-label">
            Sort by
          </label>
          <select
            id="radius-sort"
            data-testid="radius-sort-select"
            value={applied.sort}
            onChange={(event) =>
              onApply({ ...applied, sort: event.target.value as NearbySortKey, page: 1 })
            }
          >
            {NEARBY_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="chips" data-testid="radius-centre">
        <span className="chip" data-testid="radius-centre-point">
          Centre {formatCoordinate(result.centre.center.lat)},{' '}
          {formatCoordinate(result.centre.center.lon)}
        </span>
        <span className="chip" data-testid="radius-centre-source">
          {result.centre.source === 'coordinates'
            ? 'From coordinates entered directly'
            : `Resolved from ${result.centre.label ?? result.centre.parcelId ?? 'the roll'}`}
        </span>
        <span className="chip" data-testid="radius-candidates">
          {formatCount(result.candidatesScanned)} parcels inside the bounding box
        </span>
        {applied.roofAgeMin !== '' && (
          <span className="chip" data-testid="radius-chip-roof-age">
            Roof age ≥ {applied.roofAgeMin} yrs
          </span>
        )}
      </div>

      {result.total === 0 ? (
        <p className="notice" data-testid="radius-empty">
          No parcels match inside {formatMiles(result.radiusMiles)} of this centre.
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table" data-testid="radius-results-table">
              <caption className="sr-only">
                Parcels within {result.radiusMiles} miles of the centre, page {result.page} of{' '}
                {result.pageCount}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Distance</th>
                  <th scope="col">Parcel</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Year built</th>
                  <th scope="col">Roof age</th>
                  <th scope="col">Just value</th>
                  <th scope="col">Coordinates</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.parcelId} data-testid="radius-row" data-parcel-id={row.parcelId}>
                    <td className="num" data-testid="radius-cell-distance">
                      {formatMiles(row.distanceMiles)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        data-testid="radius-parcel-link"
                        data-parcel-id={row.parcelId}
                        onClick={() => onOpenParcel(row.parcelId)}
                      >
                        {row.displayTitle}
                      </button>
                      <span className="row-sub">{row.parcelId}</span>
                    </td>
                    <td data-testid="radius-cell-owner">
                      {row.ownerName === null ? (
                        MISSING
                      ) : (
                        <button
                          type="button"
                          className="link"
                          data-testid="radius-owner-link"
                          onClick={() => onOpenOwner(row.ownerName as string)}
                        >
                          {row.ownerName}
                        </button>
                      )}
                    </td>
                    <td>{row.jurisdiction ?? MISSING}</td>
                    <td className="num">{formatYear(row.yearBuilt)}</td>
                    <td className="num" data-testid="radius-cell-roof-age">
                      {formatNumber(row.roofAge)}
                    </td>
                    <td className="num">{formatCurrency(row.totalJustValue)}</td>
                    <td className="num mono" data-testid="radius-cell-coordinates">
                      {formatCoordinate(row.latitude)}, {formatCoordinate(row.longitude)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav className="pagination" aria-label="Radius results pagination">
            <button
              className="button"
              type="button"
              data-testid="radius-pagination-prev"
              disabled={result.page <= 1}
              onClick={() => onApply({ ...applied, page: result.page - 1 })}
            >
              Previous page
            </button>
            <span data-testid="radius-pagination-status">
              Page {formatCount(result.page)} of {formatCount(result.pageCount)}
            </span>
            <button
              className="button"
              type="button"
              data-testid="radius-pagination-next"
              disabled={result.page >= result.pageCount}
              onClick={() => onApply({ ...applied, page: result.page + 1 })}
            >
              Next page
            </button>
          </nav>
        </>
      )}

      <p className="footnote" data-testid="radius-provenance">
        Coordinates and roof age both come from the SCPA CAMA extract published as snapshot{' '}
        <code>{result.runId}</code>. Roof age derives from <code>max_effective_year_blt</code> and
        is null for parcels with no building, so a roof age filter excludes them.{' '}
        {result.withoutCoordinates === 0
          ? 'Every parcel in this snapshot carries a centroid.'
          : `${formatCount(result.withoutCoordinates)} parcels carry no centroid and cannot appear in any radius.`}
      </p>
    </section>
  );
}
