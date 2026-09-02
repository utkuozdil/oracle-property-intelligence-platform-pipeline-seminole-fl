import { useEffect, useState } from 'react';
import { Pagination } from './Pagination';
import { api } from './api';
import {
  MISSING,
  formatBbb,
  formatBoolean,
  formatCoordinate,
  formatCount,
  formatCurrency,
  formatMiles,
  formatNumber,
  formatYear,
} from './format';

/** Same radius as the "Parcels within 1 mile" control. Distance, not ownership. */
const NEARBY_RADIUS_MILES = 1;
const NEARBY_PAGE_SIZE = 10;

type DetailResponse = Awaited<ReturnType<typeof api.places.detail.query>>;
export type PlaceDetail = NonNullable<DetailResponse['place']>;
type NearbyResponse = Extract<
  Awaited<ReturnType<typeof api.parcels.nearby.query>>,
  { resolved: true }
>;
type NearbyRow = NearbyResponse['rows'][number];

type NearbyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: NearbyResponse }
  | { status: 'error'; message: string };

type State =
  | { status: 'loading' }
  | { status: 'ready'; place: PlaceDetail; provenance: DetailResponse['provenance'] }
  | { status: 'missing' }
  | { status: 'error'; message: string };

function Field({
  label,
  value,
  testId,
  absent = false,
}: {
  label: string;
  value: string;
  testId: string;
  absent?: boolean;
}) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className={absent ? 'value value--absent' : 'value'} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function listValue(values: string[]): { value: string; absent: boolean } {
  if (values.length === 0) return { value: MISSING, absent: true };
  return { value: values.join(', '), absent: false };
}

export interface PlaceDetailViewProps {
  gersId: string;
  onBack: () => void;
  onOpenParcel: (parcelId: string) => void;
  onOpenOwner: (owner: string) => void;
  onOpenRadius: (lat: number, lon: number, label: string) => void;
}

export function PlaceDetailView({
  gersId,
  onBack,
  onOpenParcel,
  onOpenOwner,
  onOpenRadius,
}: PlaceDetailViewProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [nearby, setNearby] = useState<NearbyState>({ status: 'idle' });
  const [nearbyPage, setNearbyPage] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.places.detail
      .query({ gersId })
      .then((response) => {
        if (cancelled) return;
        setState(
          response.place === null
            ? { status: 'missing' }
            : { status: 'ready', place: response.place, provenance: response.provenance },
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
  }, [gersId]);

  const place = state.status === 'ready' ? state.place : null;
  const lat = place?.latitude ?? null;
  const lon = place?.longitude ?? null;

  useEffect(() => {
    setNearbyPage(1);
  }, [gersId]);

  useEffect(() => {
    if (lat === null || lon === null) {
      setNearby({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setNearby({ status: 'loading' });
    api.parcels.nearby
      .query({
        lat,
        lon,
        radiusMiles: NEARBY_RADIUS_MILES,
        sort: 'distance_asc',
        page: nearbyPage,
        pageSize: NEARBY_PAGE_SIZE,
      })
      .then((response) => {
        if (cancelled) return;
        if (response.resolved === false) {
          setNearby({ status: 'error', message: 'Could not resolve this place as a centre.' });
          return;
        }
        setNearby({ status: 'ready', result: response });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setNearby({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [lat, lon, nearbyPage]);

  return (
    <section className="detail" data-testid="place-detail" aria-labelledby="place-detail-heading">
      <button
        className="button button--ghost"
        type="button"
        onClick={onBack}
        data-testid="back-to-places"
      >
        ← Back to businesses
      </button>

      {state.status === 'loading' && (
        <p className="notice" data-testid="place-detail-loading">
          Loading place {gersId}…
        </p>
      )}

      {state.status === 'missing' && (
        <p className="notice notice--error" data-testid="place-detail-missing">
          No published place has id {gersId}.
        </p>
      )}

      {state.status === 'error' && (
        <p className="notice notice--error" data-testid="place-detail-error">
          Could not load place {gersId}: {state.message}
        </p>
      )}

      {state.status === 'ready' && (
        <PlaceDetailBody
          place={state.place}
          provenance={state.provenance}
          nearby={nearby}
          onNearbyPage={setNearbyPage}
          onOpenParcel={onOpenParcel}
          onOpenOwner={onOpenOwner}
          onOpenRadius={onOpenRadius}
        />
      )}
    </section>
  );
}

function PlaceDetailBody({
  place,
  provenance,
  nearby,
  onNearbyPage,
  onOpenParcel,
  onOpenOwner,
  onOpenRadius,
}: {
  place: PlaceDetail;
  provenance: DetailResponse['provenance'];
  nearby: NearbyState;
  onNearbyPage: (page: number) => void;
  onOpenParcel: (parcelId: string) => void;
  onOpenOwner: (owner: string) => void;
  onOpenRadius: (lat: number, lon: number, label: string) => void;
}) {
  const websites = listValue(place.websites);
  const phones = listValue(place.phones);
  const emails = listValue(place.emails);
  const socials = listValue(place.socials);
  const sources = listValue(place.sourceDatasets);

  return (
    <>
      <header className="detail-head">
        <h1 id="place-detail-heading" data-testid="place-detail-title">
          {place.displayTitle}
        </h1>
        <p className="detail-sub">
          GERS <span data-testid="place-detail-gers-id">{place.gersId}</span>
          {place.isRoofing && (
            <span className="tag" data-testid="place-detail-roofing">
              roofing
            </span>
          )}
          {place.name === null && (
            <span className="tag tag--warn" data-testid="place-detail-unnamed">
              No published name
            </span>
          )}
        </p>
      </header>

      <div className="detail-grid">
        <article className="panel">
          <h2>Identity</h2>
          <dl>
            <Field label="Name" value={place.name ?? MISSING} testId="place-field-name" absent={place.name === null} />
            <Field
              label="Brand"
              value={place.brandName ?? MISSING}
              testId="place-field-brand"
              absent={place.brandName === null}
            />
            <Field
              label="Category"
              value={place.basicCategory ?? MISSING}
              testId="place-field-category"
              absent={place.basicCategory === null}
            />
            <Field
              label="Taxonomy"
              value={place.taxonomyPrimary ?? MISSING}
              testId="place-field-taxonomy"
              absent={place.taxonomyPrimary === null}
            />
            <Field
              label="Hierarchy"
              value={place.taxonomyHierarchy ?? MISSING}
              testId="place-field-hierarchy"
              absent={place.taxonomyHierarchy === null}
            />
            <Field
              label="Operating status"
              value={place.operatingStatus ?? MISSING}
              testId="place-field-status"
              absent={place.operatingStatus === null}
            />
          </dl>
        </article>

        <article className="panel">
          <h2>Location</h2>
          <dl>
            <Field
              label="Address"
              value={place.addressFreeform ?? MISSING}
              testId="place-field-address"
              absent={place.addressFreeform === null}
            />
            <Field
              label="Locality"
              value={place.addressLocality ?? MISSING}
              testId="place-field-locality"
              absent={place.addressLocality === null}
            />
            <Field
              label="Postcode"
              value={place.addressPostcode ?? MISSING}
              testId="place-field-postcode"
              absent={place.addressPostcode === null}
            />
            <Field
              label="Jurisdiction"
              value={place.jurisdiction ?? MISSING}
              testId="place-field-jurisdiction"
              absent={place.jurisdiction === null}
            />
            <Field
              label="Locality matches jurisdiction"
              value={
                place.localityMatchesJurisdiction === null
                  ? MISSING
                  : formatBoolean(place.localityMatchesJurisdiction)
              }
              testId="place-field-locality-match"
              absent={place.localityMatchesJurisdiction === null}
            />
            <Field
              label="Latitude"
              value={formatCoordinate(place.latitude)}
              testId="place-field-latitude"
              absent={place.latitude === null}
            />
            <Field
              label="Longitude"
              value={formatCoordinate(place.longitude)}
              testId="place-field-longitude"
              absent={place.longitude === null}
            />
          </dl>
          {place.latitude !== null && place.longitude !== null && (
            <div className="panel-actions">
              <button
                type="button"
                className="button"
                data-testid="place-radius-1mi"
                onClick={() => onOpenRadius(place.latitude as number, place.longitude as number, place.displayTitle)}
              >
                Parcels within 1 mile
              </button>
            </div>
          )}
        </article>

        <article className="panel">
          <h2>Contact</h2>
          <dl>
            <Field label="Phone" value={phones.value} testId="place-field-phones" absent={phones.absent} />
            <Field label="Website" value={websites.value} testId="place-field-websites" absent={websites.absent} />
            <Field label="Email" value={emails.value} testId="place-field-emails" absent={emails.absent} />
            <Field label="Social" value={socials.value} testId="place-field-socials" absent={socials.absent} />
          </dl>
        </article>

        <article className="panel">
          <h2>Provenance</h2>
          <dl>
            <Field
              label="Confidence"
              value={place.confidence === null ? MISSING : formatNumber(Number(place.confidence.toFixed(3)))}
              testId="place-field-confidence"
              absent={place.confidence === null}
            />
            <Field
              label="Confidence band"
              value={place.confidenceBand ?? MISSING}
              testId="place-field-confidence-band"
              absent={place.confidenceBand === null}
            />
            <Field
              label="Overture release"
              value={place.overtureRelease ?? provenance.release}
              testId="place-field-release"
            />
            <Field label="Sources" value={sources.value} testId="place-field-sources" absent={sources.absent} />
            <Field
              label="First seen"
              value={place.firstSeenRelease ?? MISSING}
              testId="place-field-first-seen"
              absent={place.firstSeenRelease === null}
            />
            <Field
              label="Source"
              value={`${provenance.source} · ${provenance.url}`}
              testId="place-field-provenance"
            />
          </dl>
        </article>

        {place.roofing !== null && (
          <article className="panel panel--wide" data-testid="place-roofing-join">
            <h2>Roofing join</h2>
            <p className="footnote">
              Permit contractor and BBB rating are name matches, not identifier lookups. Both
              scores travel with the row so the hop is visible.
            </p>
            <dl>
              <Field
                label="Permit contractor"
                value={place.roofing.permitContractorName ?? MISSING}
                testId="place-field-permit-contractor"
                absent={!place.roofing.permitMatched}
              />
              <Field
                label="Permit match"
                value={
                  place.roofing.permitMatched
                    ? `${place.roofing.permitMatchTier ?? 'matched'} (${place.roofing.permitMatchConfidence.toFixed(2)})`
                    : 'No defensible permit match'
                }
                testId="place-field-permit-match"
              />
              <Field
                label="BBB"
                value={
                  place.roofing.bbbMatched
                    ? `${formatBbb(place.roofing.bbbRating)} · ${place.roofing.bbbBusinessName ?? MISSING}`
                    : 'No BBB match'
                }
                testId="place-field-bbb"
              />
            </dl>
          </article>
        )}
      </div>

      <NearbyParcels
        nearby={nearby}
        onNearbyPage={onNearbyPage}
        onOpenParcel={onOpenParcel}
        onOpenOwner={onOpenOwner}
        onOpenRadius={
          place.latitude !== null && place.longitude !== null
            ? () => onOpenRadius(place.latitude as number, place.longitude as number, place.displayTitle)
            : undefined
        }
      />
    </>
  );
}

function NearbyParcels({
  nearby,
  onNearbyPage,
  onOpenParcel,
  onOpenOwner,
  onOpenRadius,
}: {
  nearby: NearbyState;
  onNearbyPage: (page: number) => void;
  onOpenParcel: (parcelId: string) => void;
  onOpenOwner: (owner: string) => void;
  onOpenRadius?: () => void;
}) {
  if (nearby.status === 'idle') return null;

  return (
    <section className="results" aria-labelledby="place-parcels-heading">
      <header className="results-head">
        <h2 id="place-parcels-heading">Parcels nearby</h2>
        <div className="results-meta">
          <strong data-testid="place-nearby-total">
            {nearby.status === 'ready' ? formatCount(nearby.result.total) : '…'}
          </strong>
          <span> within {NEARBY_RADIUS_MILES} mile</span>
        </div>
        {onOpenRadius !== undefined && (
          <div className="results-controls">
            <button
              type="button"
              className="button"
              data-testid="place-open-radius"
              onClick={onOpenRadius}
            >
              Open in radius search
            </button>
          </div>
        )}
      </header>

      {nearby.status === 'loading' && (
        <p className="notice" data-testid="place-nearby-loading">
          Joining parcels by distance from this pin…
        </p>
      )}

      {nearby.status === 'error' && (
        <p className="notice notice--error" data-testid="place-nearby-error">
          Could not join nearby parcels: {nearby.message}
        </p>
      )}

      {nearby.status === 'ready' && nearby.result.total === 0 && (
        <p className="notice" data-testid="place-nearby-empty">
          No parcels in this snapshot sit within {NEARBY_RADIUS_MILES} mile of this place.
        </p>
      )}

      {nearby.status === 'ready' && nearby.result.total > 0 && (
        <>
          <div className="table-wrap">
            <table className="table" data-testid="place-nearby-table">
              <thead>
                <tr>
                  <th scope="col">Parcel</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Year built</th>
                  <th scope="col">Roof age</th>
                  <th scope="col">Just value</th>
                  <th scope="col">Distance</th>
                </tr>
              </thead>
              <tbody>
                {nearby.result.rows.map((row) => (
                  <NearbyParcelRow
                    key={row.parcelId}
                    row={row}
                    onOpenParcel={onOpenParcel}
                    onOpenOwner={onOpenOwner}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={nearby.result.page}
            pageCount={nearby.result.pageCount}
            onPage={onNearbyPage}
            label="Nearby parcels pagination"
            testId="place-nearby-pagination"
          />
        </>
      )}

      <p className="footnote" data-testid="place-nearby-note">
        These parcels are joined by distance from the place pin, not by ownership. A business
        location is not a roll owner. Click a parcel to open it the same way an owner holding
        does.
      </p>
    </section>
  );
}

function NearbyParcelRow({
  row,
  onOpenParcel,
  onOpenOwner,
}: {
  row: NearbyRow;
  onOpenParcel: (parcelId: string) => void;
  onOpenOwner: (owner: string) => void;
}) {
  return (
    <tr data-testid="place-nearby-row" data-parcel-id={row.parcelId}>
      <td>
        <button
          type="button"
          className="link"
          data-testid="place-nearby-parcel-link"
          data-parcel-id={row.parcelId}
          onClick={() => onOpenParcel(row.parcelId)}
        >
          {row.displayTitle}
        </button>
        <span className="row-sub">{row.parcelId}</span>
      </td>
      <td>
        {row.ownerName === null ? (
          MISSING
        ) : (
          <button
            type="button"
            className="link"
            data-testid="place-nearby-owner-link"
            data-owner={row.ownerName}
            onClick={() => onOpenOwner(row.ownerName as string)}
          >
            {row.ownerName}
          </button>
        )}
      </td>
      <td>{row.jurisdiction ?? MISSING}</td>
      <td className="num">{formatYear(row.yearBuilt)}</td>
      <td className="num">{formatNumber(row.roofAge)}</td>
      <td className="num">{formatCurrency(row.totalJustValue)}</td>
      <td className="num">{formatMiles(row.distanceMiles)}</td>
    </tr>
  );
}
