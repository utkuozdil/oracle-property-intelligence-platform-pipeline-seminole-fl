import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentView } from './AgentView';
import { OwnerDetailView } from './OwnerViews';
import { ParcelDetailView } from './ParcelDetailView';
import { RadiusSearchView, type RadiusState } from './RadiusSearchView';
import { RunSummaryView } from './RunSummaryView';
import { SearchView, type SearchState } from './SearchView';
import { api } from './api';
import { formatCount } from './format';
import {
  EMPTY_RADIUS,
  parseLocation,
  toNearbyInput,
  toSearchInput,
  toSearchString,
  type AppState,
  type RadiusQuery,
  type SearchQuery,
  type ViewName,
} from './query';

type MetaResponse = Awaited<ReturnType<typeof api.parcels.meta.query>>;

const NAV_ITEMS: { view: ViewName; label: string }[] = [
  { view: 'runs', label: 'Run summary' },
  { view: 'search', label: 'Parcel search' },
  { view: 'radius', label: 'Radius search' },
  { view: 'agent', label: 'Ask the agent' },
];

function formatQueryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('radiusMiles') && /too_big|<=\s*50/i.test(raw)) {
    return 'Radius can be at most 50 miles — that covers the whole county.';
  }
  if (raw.includes('Provide either lat and lon')) {
    return 'Enter a place name, or a latitude and longitude.';
  }
  if (raw.trimStart().startsWith('[')) {
    return 'That search could not be run. Check the centre and keep the radius at 50 miles or less.';
  }
  return raw;
}

/**
 * URL-driven shell. Every piece of view state — which view is open, filters, the radius
 * centre, the page, the open parcel, and the open owner — lives in the query string, so
 * every result is linkable and the browser back button steps back through detail views
 * without extra history plumbing.
 */
export function App() {
  const [state, setState] = useState<AppState>(() => parseLocation(window.location.search));
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>({ status: 'loading' });
  const [radius, setRadius] = useState<RadiusState>({ status: 'idle' });

  useEffect(() => {
    const onPopState = (): void => setState(parseLocation(window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: AppState) => {
    window.history.pushState(null, '', toSearchString(next));
    setState(next);
  }, []);

  const onApply = useCallback(
    (query: SearchQuery) =>
      navigate({ ...state, view: 'search', query, parcelId: null, owner: null }),
    [navigate, state],
  );
  const onApplyRadius = useCallback(
    (next: RadiusQuery) =>
      navigate({ ...state, view: 'radius', radius: next, parcelId: null, owner: null }),
    [navigate, state],
  );
  const onOpenParcel = useCallback(
    (parcelId: string) => navigate({ ...state, parcelId, owner: null }),
    [navigate, state],
  );
  const onOpenOwner = useCallback(
    (owner: string) => navigate({ ...state, owner, parcelId: null }),
    [navigate, state],
  );
  const onOpenView = useCallback(
    (view: ViewName) => navigate({ ...state, view, parcelId: null, owner: null }),
    [navigate, state],
  );
  const onBack = useCallback(
    () => navigate({ ...state, parcelId: null, owner: null }),
    [navigate, state],
  );

  /** Opening radius search from another view: set the centre and the filters in one step. */
  const onOpenRadiusAt = useCallback(
    (near: string, radiusMiles = '5', roofAgeMin = '') =>
      navigate({
        ...state,
        view: 'radius',
        radius: { ...EMPTY_RADIUS, near, radiusMiles, roofAgeMin },
        parcelId: null,
        owner: null,
      }),
    [navigate, state],
  );

  useEffect(() => {
    let cancelled = false;
    api.parcels.meta
      .query()
      .then((response) => {
        if (!cancelled) setMeta(response);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMetaError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sequence-guarded so a slow earlier response can never overwrite a newer one.
  const requestSeq = useRef(0);
  const { query } = state;

  useEffect(() => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setSearch({ status: 'loading' });

    api.parcels.search
      .query(toSearchInput(query))
      .then((result) => {
        if (requestSeq.current === seq) setSearch({ status: 'ready', result });
      })
      .catch((error: unknown) => {
        if (requestSeq.current !== seq) return;
        setSearch({
          status: 'error',
          message: formatQueryError(error),
        });
      });
  }, [query]);

  const radiusSeq = useRef(0);
  const radiusQuery = state.radius;
  const radiusActive = state.view === 'radius';

  useEffect(() => {
    if (!radiusActive) return;
    const input = toNearbyInput(radiusQuery);
    if (input === null) {
      setRadius({ status: 'idle' });
      return;
    }

    const seq = radiusSeq.current + 1;
    radiusSeq.current = seq;
    setRadius({ status: 'loading' });

    api.parcels.nearby
      .query(input)
      .then((result) => {
        if (radiusSeq.current === seq) setRadius({ status: 'ready', result });
      })
      .catch((error: unknown) => {
        if (radiusSeq.current !== seq) return;
        setRadius({
          status: 'error',
          message: formatQueryError(error),
        });
      });
  }, [radiusActive, radiusQuery]);

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <span className="brand-name">Oracle Property Intelligence</span>
            <span className="brand-sub">Seminole County, Florida</span>
          </div>
        </div>
        <dl className="snapshot" data-testid="snapshot-meta">
          <div>
            <dt>Parcels</dt>
            <dd data-testid="snapshot-parcel-count">
              {meta ? formatCount(meta.parcelCount) : '…'}
            </dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd data-testid="snapshot-published-at">
              {meta ? meta.publishedAt.slice(0, 19).replace('T', ' ') + ' UTC' : '…'}
            </dd>
          </div>
        </dl>
      </header>

      <nav className="viewnav" aria-label="Views" data-testid="view-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            className={state.view === item.view ? 'viewnav-tab viewnav-tab--active' : 'viewnav-tab'}
            data-testid={`nav-${item.view}`}
            aria-current={state.view === item.view ? 'page' : undefined}
            onClick={() => onOpenView(item.view)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {metaError !== null && (
          <p className="notice notice--error" data-testid="meta-error">
            Could not load snapshot metadata: {metaError}
          </p>
        )}

        {state.parcelId !== null ? (
          <ParcelDetailView
            parcelId={state.parcelId}
            onBack={onBack}
            onOpenOwner={onOpenOwner}
            onOpenRadius={onOpenRadiusAt}
          />
        ) : state.owner !== null ? (
          <OwnerDetailView
            owner={state.owner}
            onBack={onBack}
            onOpenParcel={onOpenParcel}
            onOpenRadius={(near) => onOpenRadiusAt(near, '1', '')}
          />
        ) : state.view === 'runs' ? (
          <RunSummaryView />
        ) : state.view === 'radius' ? (
          <RadiusSearchView
            applied={state.radius}
            meta={meta}
            state={radius}
            onApply={onApplyRadius}
            onOpenParcel={onOpenParcel}
            onOpenOwner={onOpenOwner}
          />
        ) : state.view === 'agent' ? (
          <AgentView
            currentNear={state.radius.near}
            currentRadiusMiles={state.radius.radiusMiles}
            currentRoofAgeMin={state.radius.roofAgeMin}
            onOpenParcel={onOpenParcel}
          />
        ) : (
          <SearchView
            applied={state.query}
            meta={meta}
            search={search}
            onApply={onApply}
            onOpenParcel={onOpenParcel}
            onOpenOwner={onOpenOwner}
          />
        )}
      </main>
    </div>
  );
}
