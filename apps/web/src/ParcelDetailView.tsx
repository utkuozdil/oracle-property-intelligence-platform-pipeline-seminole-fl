import { useEffect, useState } from 'react';
import { api } from './api';
import {
  MISSING,
  formatBoolean,
  formatCoordinate,
  formatCurrency,
  formatDate,
  formatNumber,
  formatYear,
} from './format';

type DetailResponse = Awaited<ReturnType<typeof api.parcels.detail.query>>;
export type ParcelDetail = NonNullable<DetailResponse['parcel']>;

type State =
  | { status: 'loading' }
  | { status: 'ready'; parcel: ParcelDetail }
  | { status: 'missing' }
  | { status: 'error'; message: string };

interface FieldProps {
  label: string;
  value: string;
  testId: string;
  /** Marks a value the source data does not carry, so a dash is never ambiguous. */
  absent?: boolean;
}

function Field({ label, value, testId, absent = false }: FieldProps) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className={absent ? 'value value--absent' : 'value'} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export interface ParcelDetailViewProps {
  parcelId: string;
  onBack: () => void;
  /** Follows the parcel→owner edge to the owner entity view. */
  onOpenOwner: (owner: string) => void;
  /** Opens radius search centred on this parcel. */
  onOpenRadius: (near: string, radiusMiles?: string, roofAgeMin?: string) => void;
}

export function ParcelDetailView({
  parcelId,
  onBack,
  onOpenOwner,
  onOpenRadius,
}: ParcelDetailViewProps) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.parcels.detail
      .query({ parcelId })
      .then((response) => {
        if (cancelled) return;
        setState(
          response.parcel === null
            ? { status: 'missing' }
            : { status: 'ready', parcel: response.parcel },
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
  }, [parcelId]);

  return (
    <section className="detail" data-testid="parcel-detail" aria-labelledby="detail-heading">
      <button
        className="button button--ghost"
        type="button"
        onClick={onBack}
        data-testid="back-to-results"
      >
        ← Back to results
      </button>

      {state.status === 'loading' && (
        <p className="notice" data-testid="detail-loading">
          Loading parcel {parcelId}…
        </p>
      )}

      {state.status === 'missing' && (
        <p className="notice notice--error" data-testid="detail-missing">
          No parcel in this snapshot has id {parcelId}.
        </p>
      )}

      {state.status === 'error' && (
        <p className="notice notice--error" data-testid="detail-error">
          Could not load parcel {parcelId}: {state.message}
        </p>
      )}

      {state.status === 'ready' && (
        <ParcelDetailBody
          parcel={state.parcel}
          onOpenOwner={onOpenOwner}
          onOpenRadius={onOpenRadius}
        />
      )}
    </section>
  );
}

function ParcelDetailBody({
  parcel,
  onOpenOwner,
  onOpenRadius,
}: {
  parcel: ParcelDetail;
  onOpenOwner: (owner: string) => void;
  onOpenRadius: (near: string, radiusMiles?: string, roofAgeMin?: string) => void;
}) {
  return (
    <>
      <header className="detail-head">
        <h1 id="detail-heading" data-testid="detail-title">
          {parcel.displayTitle}
        </h1>
        <p className="detail-sub">
          Parcel <span data-testid="detail-parcel-id">{parcel.parcelId}</span>
          {!parcel.hasAddress && (
            <span className="tag tag--warn" data-testid="detail-no-address">
              No situs address recorded for this parcel
            </span>
          )}
        </p>
      </header>

      <div className="detail-grid">
        <article className="panel">
          <h2>Identity</h2>
          <dl>
            <Field label="Parcel ID" value={parcel.parcelId} testId="detail-field-parcel-id" />
            <Field
              label="Situs address"
              value={parcel.hasAddress ? parcel.displayTitle : MISSING}
              testId="detail-field-address"
              absent={!parcel.hasAddress}
            />
            <Field
              label="Jurisdiction"
              value={parcel.jurisdiction ?? MISSING}
              testId="detail-field-jurisdiction"
              absent={parcel.jurisdiction === null}
            />
            <Field
              label="Property type"
              value={parcel.propertyType ?? MISSING}
              testId="detail-field-property-type"
              absent={parcel.propertyType === null}
            />
            <Field
              label="DOR code"
              value={parcel.dorCode ?? MISSING}
              testId="detail-field-dor-code"
              absent={parcel.dorCode === null}
            />
            <Field
              label="Subdivision"
              value={parcel.subdivision ?? MISSING}
              testId="detail-field-subdivision"
              absent={parcel.subdivision === null}
            />
          </dl>
        </article>

        <article className="panel">
          <h2>Owner</h2>
          <dl>
            <div className="field">
              <dt>Owner name</dt>
              <dd
                className={parcel.ownerName === null ? 'value value--absent' : 'value'}
                data-testid="detail-field-owner-name"
              >
                {parcel.ownerName === null ? (
                  MISSING
                ) : (
                  <button
                    type="button"
                    className="link"
                    data-testid="detail-owner-link"
                    data-owner={parcel.ownerName}
                    onClick={() => onOpenOwner(parcel.ownerName as string)}
                  >
                    {parcel.ownerName}
                  </button>
                )}
              </dd>
            </div>
            <Field
              label="Mailing city / state / ZIP"
              value={parcel.mailingCityStateZip ?? MISSING}
              testId="detail-field-mailing"
              absent={parcel.mailingCityStateZip === null}
            />
            <Field
              label="Owner out of area"
              value={formatBoolean(parcel.ownerOutOfArea)}
              testId="detail-field-out-of-area"
            />
            <Field
              label="Homestead exemption"
              value={formatBoolean(parcel.hasHomestead)}
              testId="detail-field-homestead"
            />
          </dl>
        </article>

        <article className="panel">
          <h2>Valuation</h2>
          <dl>
            <Field
              label="Total just value"
              value={formatCurrency(parcel.totalJustValue)}
              testId="detail-field-just-value"
            />
            <Field
              label="Assessed value"
              value={formatCurrency(parcel.assessedValue)}
              testId="detail-field-assessed-value"
            />
            <Field
              label="Taxable value"
              value={formatCurrency(parcel.taxableValue)}
              testId="detail-field-taxable-value"
            />
            <Field
              label="Annual tax total"
              value={formatCurrency(parcel.annualTaxTotal)}
              testId="detail-field-annual-tax"
              absent={parcel.annualTaxTotal === null}
            />
          </dl>
        </article>

        <article className="panel">
          <h2>Structure</h2>
          <dl>
            <Field
              label="Year built"
              value={formatYear(parcel.yearBuilt)}
              testId="detail-field-year-built"
              absent={parcel.yearBuilt === null}
            />
            <Field
              label="Max effective year built"
              value={formatYear(parcel.maxEffectiveYearBlt)}
              testId="detail-field-max-effective-year"
              absent={parcel.maxEffectiveYearBlt === null}
            />
            <Field
              label="Roof age (years)"
              value={formatNumber(parcel.roofAge)}
              testId="detail-field-roof-age"
              absent={parcel.roofAge === null}
            />
            <Field
              label="Living area (sq ft)"
              value={formatNumber(parcel.totalLivingArea)}
              testId="detail-field-living-area"
              absent={parcel.totalLivingArea === null}
            />
            <Field
              label="Bedrooms"
              value={formatNumber(parcel.totalBedrooms)}
              testId="detail-field-bedrooms"
              absent={parcel.totalBedrooms === null}
            />
            <Field
              label="Bathrooms"
              value={formatNumber(parcel.totalBathrooms)}
              testId="detail-field-bathrooms"
              absent={parcel.totalBathrooms === null}
            />
            <Field
              label="Has building"
              value={formatBoolean(parcel.hasBuilding)}
              testId="detail-field-has-building"
            />
            <Field label="Pool" value={formatBoolean(parcel.hasPool)} testId="detail-field-pool" />
            <Field
              label="Fireplace"
              value={formatBoolean(parcel.hasFireplace)}
              testId="detail-field-fireplace"
            />
            <Field
              label="Demolition flag"
              value={formatBoolean(parcel.demolitionFlag)}
              testId="detail-field-demolition"
            />
          </dl>
          <p className="footnote" data-testid="roof-age-provenance">
            Roof age is derived from <code>max_effective_year_blt</code>, not{' '}
            <code>year_built</code>. It is null for the 19,239 parcels that carry no building.
          </p>
        </article>

        <article className="panel">
          <h2>Sale history</h2>
          <dl>
            <Field
              label="Last sale date"
              value={formatDate(parcel.lastSaleDate)}
              testId="detail-field-last-sale-date"
              absent={parcel.lastSaleDate === null}
            />
            <Field
              label="Last sale amount"
              value={formatCurrency(parcel.lastSaleAmount)}
              testId="detail-field-last-sale-amount"
              absent={parcel.lastSaleAmount === null}
            />
            <Field
              label="Years since sale"
              value={formatNumber(parcel.yearsSinceSale)}
              testId="detail-field-years-since-sale"
              absent={parcel.yearsSinceSale === null}
            />
            <Field
              label="Recorded sale count"
              value={formatNumber(parcel.saleCount)}
              testId="detail-field-sale-count"
              absent={parcel.saleCount === null}
            />
          </dl>
          <p className="footnote">
            Only the most recent sale is carried in this snapshot; earlier transactions are
            summarised by the recorded sale count.
          </p>
        </article>

        <article className="panel">
          <h2>Coordinates</h2>
          <dl>
            <Field
              label="Latitude"
              value={formatCoordinate(parcel.latitude)}
              testId="detail-field-latitude"
            />
            <Field
              label="Longitude"
              value={formatCoordinate(parcel.longitude)}
              testId="detail-field-longitude"
            />
          </dl>
          {parcel.latitude !== null && parcel.longitude !== null && (
            <div className="panel-actions">
              <button
                type="button"
                className="button"
                data-testid="detail-radius-1mi"
                onClick={() => onOpenRadius(parcel.parcelId, '1', '')}
              >
                Parcels within 1 mile
              </button>
              <button
                type="button"
                className="button"
                data-testid="detail-radius-aged-roofs"
                onClick={() => onOpenRadius(parcel.parcelId, '1', '15')}
              >
                Roofs over 15 years within 1 mile
              </button>
            </div>
          )}
        </article>
      </div>
    </>
  );
}
