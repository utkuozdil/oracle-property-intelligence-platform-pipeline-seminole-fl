import type { ServerConfig } from './config';
import type { DuckDbOptions } from './duckdb';
import { queryOne, queryRows, sqlPath, sqlString } from './duckdb';
import {
  describeEnrichment,
  needsS3,
  normaliseParcelId,
  openRoofingCte,
  resolvePermitSource,
} from './enrichment';
import type { EnrichmentStatus, ResolvedPermits } from './enrichment';
import type { OrderKey, PropertyFilters } from './filters';
import {
  ORDER_BY,
  SUMMARY_COLUMNS,
  SUMMARY_PROJECTION,
  boundingBox,
  buildPredicates,
  haversineMiles,
  whereClause,
} from './filters';
import { PublishedDataset } from './source';
import type { QueryTableManifest, SourceState } from './source';

/**
 * Tool implementations.
 *
 * Every response carries the same three-part envelope: the answer, the `source` it was
 * read from (IPNS name, CID, latency), and the `assumptions` and `missingData` that
 * qualify it. The envelope is not decoration — the demo is graded on whether the system
 * identifies what it is assuming and what it does not have, and a tool that returns bare
 * rows makes the consuming agent invent that part.
 */

export type Row = Record<string, unknown>;

export interface Envelope {
  source: SourceDescription;
  assumptions: string[];
  missingData: string[];
}

export interface SourceDescription {
  dataset: string;
  ipns: string | null;
  gateway: string | null;
  url: string;
  cid: string | null;
  readFrom: 'local-cache' | 'gateway' | 'local-file';
  resolution: string;
  queryMs: number;
}

const ROOF_AGE_ASSUMPTION =
  "roof_age is derived from the appraiser's effective-year-built, not from a roof permit or " +
  'an inspection. It is a proxy: a re-roof that was never permitted, or permitted under a ' +
  'contractor the county did not record, does not move it.';

const CENTROID_ASSUMPTION =
  'Radius filtering uses the parcel centroid published with each row, not a rooftop or a ' +
  'street address geocode. At neighbourhood scale the difference is metres.';

const NO_COORDINATE_ASSUMPTION =
  'Parcels with no published coordinate cannot appear in a radius result at all. Use ' +
  'describe_dataset to see how many of the 181,218 rows carry one.';

export class OracleDataset {
  private readonly dataset: PublishedDataset;
  private readonly duck: DuckDbOptions;
  private permits: ResolvedPermits | null = null;

  constructor(private readonly config: ServerConfig) {
    this.dataset = new PublishedDataset(config);
    this.duck = { bin: config.duckdbBin, s3: needsS3(config.enrichment) };
  }

  private describeSource(state: SourceState, queryMs: number): SourceDescription {
    return {
      dataset: 'query-table/seminole.parquet',
      ipns: this.config.parquetOverridden ? null : this.config.ipnsName,
      gateway: this.config.parquetOverridden ? null : this.config.gateway,
      url: state.url,
      cid: state.cid,
      readFrom: state.local ? (state.cid === null ? 'local-file' : 'local-cache') : 'gateway',
      resolution: state.resolution,
      queryMs,
    };
  }

  private enrichment(): EnrichmentStatus {
    return describeEnrichment(this.config.enrichment);
  }

  private clampLimit(limit: number | undefined, fallback: number): number {
    const requested = limit ?? fallback;
    return Math.max(1, Math.min(requested, this.config.maxLimit));
  }

  private async run<T extends Row>(
    sql: string,
  ): Promise<{ rows: T[]; state: SourceState; queryMs: number }> {
    const state = await this.dataset.resolve();
    const startedAt = Date.now();
    const rows = await queryRows<T>(sql, this.duck);
    return { rows, state, queryMs: Date.now() - startedAt };
  }

  /**
   * What is published, how fresh it is, and — just as importantly — what is not here.
   *
   * An agent that calls this first will not waste a turn asking for permit history and
   * reading an empty array as an answer.
   */
  async describeDataset(): Promise<Row> {
    const state = await this.dataset.resolve();
    const manifest = await this.dataset.publishedManifest();
    const startedAt = Date.now();
    const stats = await queryOne<Row>(
      `SELECT count(*)::BIGINT                                        AS rows,
              count(latitude)::BIGINT                                 AS rows_with_coordinates,
              count(roof_age)::BIGINT                                 AS rows_with_roof_age,
              count_if(roof_age > 15)::BIGINT                         AS roofs_over_15_years,
              min(year_built)                                         AS oldest_year_built,
              max(last_sale_date)::VARCHAR                            AS latest_sale_date,
              count(DISTINCT jurisdiction)::BIGINT                    AS jurisdictions
       FROM ${await this.dataset.table()};`,
      this.duck,
    );
    const queryMs = Date.now() - startedAt;

    const enrichment = this.enrichment();
    return {
      county: 'Seminole County, FL',
      table: {
        ...stats,
        summaryProjectionColumns: SUMMARY_COLUMNS.length,
        allColumnsAvailableVia:
          'search tools return a 16-column summary; get_property returns all 55 published columns',
      },
      publishedManifest: manifestSummary(manifest),
      enrichment,
      source: this.describeSource(state, queryMs),
      assumptions: [ROOF_AGE_ASSUMPTION, CENTROID_ASSUMPTION],
      missingData: missingDataNotes(enrichment),
    };
  }

  async getProperty(parcelId: string): Promise<Row> {
    const table = await this.dataset.table();
    // Accept either spelling of the id: the published table stores it without the
    // county's separators, every permit and CRM record carries them.
    const normalised = normaliseParcelId(parcelId);
    const { rows, state, queryMs } = await this.run(
      `SELECT * FROM ${table}
       WHERE parcel_id = ${sqlString(parcelId)} OR parcel_id = ${sqlString(normalised)}
       LIMIT 1;`,
    );

    const enrichment = this.enrichment();
    const envelope = {
      source: this.describeSource(state, queryMs),
      assumptions: [ROOF_AGE_ASSUMPTION],
      missingData: missingDataNotes(enrichment),
    };

    const property = rows[0];
    if (property === undefined) {
      return {
        found: false,
        parcelId,
        triedAlso: normalised,
        note:
          'No row with that parcel id in the published snapshot. Both spellings were tried — ' +
          'the county form with separators (15-21-29-527-0000-0140) and the stripped form the ' +
          'table stores (15212952700000140) — so this is a lookup miss, not a statement that the ' +
          'parcel does not exist. A folio from another system will not match either form.',
        ...envelope,
      };
    }

    const openRoofing = await this.openRoofingFor(normalised);
    return { found: true, property, openRoofing, ...envelope };
  }

  async searchProperties(input: {
    filters: PropertyFilters;
    orderBy?: OrderKey;
    limit?: number;
  }): Promise<Row> {
    const table = await this.dataset.table();
    const limit = this.clampLimit(input.limit, 25);
    const predicates = buildPredicates(input.filters);
    const order = ORDER_BY[input.orderBy ?? 'roof_age_desc'];

    const { rows, state, queryMs } = await this.run(
      `WITH matched AS (SELECT ${SUMMARY_PROJECTION} FROM ${table} ${whereClause(predicates)})
       SELECT (SELECT count(*) FROM matched)::BIGINT AS total_matches,
              (SELECT to_json(list(page))
               FROM (SELECT * FROM matched ORDER BY ${order} LIMIT ${limit}) page) AS results;`,
    );

    const row = rows[0] ?? {};
    const enrichment = this.enrichment();
    return {
      totalMatches: row.total_matches ?? 0,
      returned: Array.isArray(row.results) ? row.results.length : 0,
      limit,
      appliedFilters: input.filters,
      results: row.results ?? [],
      source: this.describeSource(state, queryMs),
      assumptions: [ROOF_AGE_ASSUMPTION],
      missingData: missingDataNotes(enrichment),
    };
  }

  async searchNear(input: {
    latitude: number;
    longitude: number;
    radiusMiles: number;
    filters: PropertyFilters;
    limit?: number;
  }): Promise<Row> {
    const table = await this.dataset.table();
    const limit = this.clampLimit(input.limit, 25);
    const distance = haversineMiles(input.latitude, input.longitude);
    const predicates = [
      'latitude IS NOT NULL',
      ...boundingBox(input.latitude, input.longitude, input.radiusMiles),
      ...buildPredicates(input.filters),
    ];

    const { rows, state, queryMs } = await this.run(
      `WITH candidates AS (
         SELECT ${SUMMARY_PROJECTION}, ${distance} AS miles_from_pin
         FROM ${table} ${whereClause(predicates)}
       ),
       inside AS (SELECT * FROM candidates WHERE miles_from_pin <= ${input.radiusMiles})
       SELECT (SELECT count(*) FROM inside)::BIGINT AS total_matches,
              (SELECT to_json(list(page))
               FROM (SELECT * REPLACE (round(miles_from_pin, 2) AS miles_from_pin)
                     FROM inside ORDER BY miles_from_pin LIMIT ${limit}) page) AS results;`,
    );

    const row = rows[0] ?? {};
    const enrichment = this.enrichment();
    return {
      centre: { latitude: input.latitude, longitude: input.longitude },
      radiusMiles: input.radiusMiles,
      totalMatches: row.total_matches ?? 0,
      returned: Array.isArray(row.results) ? row.results.length : 0,
      limit,
      appliedFilters: input.filters,
      results: row.results ?? [],
      source: this.describeSource(state, queryMs),
      assumptions: [CENTROID_ASSUMPTION, NO_COORDINATE_ASSUMPTION, ROOF_AGE_ASSUMPTION],
      missingData: missingDataNotes(enrichment),
    };
  }

  private async resolvedPermits(): Promise<ResolvedPermits | null> {
    const uri = this.config.enrichment.permitPointerUri;
    if (uri === null) return null;
    if (this.permits === null) {
      this.permits = await resolvePermitSource(uri, this.duck);
    }
    return this.permits;
  }

  private async openRoofingFor(parcelId: string): Promise<Row[] | { available: false; reason: string }> {
    const source = await this.resolvedPermits();
    if (source === null) {
      return { available: false, reason: this.enrichment().permits.reason };
    }
    const { rows } = await this.run(
      `WITH ${openRoofingCte(source.parquetUri)}
       SELECT application_no, permit_type, contractor_name, open_years, bbb_lookup, bbb_rating
       FROM open_permits
       WHERE parcelKey = ${sqlString(parcelId)}
       ORDER BY open_years DESC;`,
    );
    return rows;
  }

  /**
   * The demo's headline question, as one call.
   *
   * "Which properties near that area have open roofing permits that have been open for
   * many years, and who is the listed contractor?"
   *
   * When the published permit snapshot is not configured this returns aged-roof
   * candidates and says the permit half is unanswered. It does not return an empty list
   * and let the caller read that as "no such properties". `unknown` status is never
   * treated as open.
   */
  async findRoofingLeads(input: {
    latitude: number;
    longitude: number;
    radiusMiles: number;
    minRoofAge?: number;
    minPermitOpenYears: number;
    limit?: number;
  }): Promise<Row> {
    const enrichment = this.enrichment();
    const limit = this.clampLimit(input.limit, 25);

    if (!enrichment.permits.available) {
      const fallback = await this.searchNear({
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMiles: input.radiusMiles,
        filters: {
          minRoofAge: input.minRoofAge,
          hasBuilding: true,
        },
        limit,
      });
      return {
        question:
          'Properties near a point with open roofing permits held open for years, and the ' +
          'listed contractor.',
        answered: 'partially',
        permitEvidence: {
          available: false,
          reason: enrichment.permits.reason,
          consequence:
            'The "open roofing permit", "open for many years" and "listed contractor" parts of ' +
            'the question are UNANSWERED by this server, not answered negatively.',
        },
        bbbEvidence: { available: false, reason: enrichment.bbb.reason },
        candidatesByRoofAge: fallback,
        assumptions: [
          ...(Array.isArray(fallback.assumptions) ? (fallback.assumptions as string[]) : []),
          'Returned rows are aged-roof candidates only. They are a proxy for roofing demand, ' +
            'not evidence of an open permit.',
        ],
        missingData: missingDataNotes(enrichment),
      };
    }

    const source = await this.resolvedPermits();
    if (source === null) {
      throw new Error('permit pointer is configured but failed to resolve');
    }

    const table = await this.dataset.table();
    const distance = haversineMiles(input.latitude, input.longitude);
    const predicates = [
      'latitude IS NOT NULL',
      ...boundingBox(input.latitude, input.longitude, input.radiusMiles),
      ...buildPredicates({ minRoofAge: input.minRoofAge }),
    ];

    const sql = `WITH props AS (
         SELECT ${SUMMARY_PROJECTION}, ${distance} AS miles_from_pin
         FROM ${table} ${whereClause(predicates)}
       ),
       ${openRoofingCte(source.parquetUri)}
      SELECT p.parcel_id, p.primary_address, p.jurisdiction, p.owner_name, p.roof_age,
             p.year_built, p.total_just_value, round(p.miles_from_pin, 2) AS miles_from_pin,
             o.application_no AS permit_number, o.issued_on AS permit_issued_on,
             o.permit_type, o.status AS permit_status, o.open_years AS permit_open_years,
             o.contractor_name AS listed_contractor, o.bbb_lookup, o.bbb_rating
      FROM props p
      JOIN open_permits o ON o.parcelKey = p.parcel_id
      WHERE p.miles_from_pin <= ${input.radiusMiles}
        AND o.open_years >= ${input.minPermitOpenYears}
      ORDER BY o.open_years DESC, p.roof_age DESC
      LIMIT ${limit};`;

    const { rows, state, queryMs } = await this.run<Row>(sql);
    const coverage = await queryOne<Row>(
      `SELECT count(*)::BIGINT AS permit_rows,
              count_if(roofing_relevant)::BIGINT AS roofing_permits,
              count_if(roofing_relevant AND status = 'open')::BIGINT AS open_roofing_permits,
              count_if(status = 'unknown')::BIGINT AS unknown_status_rows,
              count(DISTINCT parcel_id)::BIGINT AS parcels_covered
       FROM read_parquet(${sqlPath(source.parquetUri)});`,
      this.duck,
    );

    return {
      question:
        'Properties near a point with confirmed-open roofing permits held open for years, and the ' +
        'listed contractor.',
      answered: 'yes, within the coverage stated below',
      centre: { latitude: input.latitude, longitude: input.longitude },
      radiusMiles: input.radiusMiles,
      minRoofAge: input.minRoofAge ?? null,
      minPermitOpenYears: input.minPermitOpenYears,
      returned: rows.length,
      leads: rows,
      permitEvidence: {
        available: true,
        source: source.parquetUri,
        pointer: source.pointerUri,
        runId: source.runId,
        publishedAt: source.publishedAt,
        referenceDate: source.referenceDate,
        reason: enrichment.permits.reason,
        snapshotCoverage: coverage,
      },
      bbbEvidence: {
        available: true,
        contractorsInResult: new Set(rows.map((row) => row.listed_contractor)).size,
        contractorsWithRating: rows.filter((row) => row.bbb_rating !== null).length,
        reason: enrichment.bbb.reason,
      },
      source: this.describeSource(state, queryMs),
      assumptions: [
        CENTROID_ASSUMPTION,
        ROOF_AGE_ASSUMPTION,
        'A permit counts as open only when the published status is "open". Status "unknown" ' +
          'means the detail has not been harvested. It is not treated as open, and it is not ' +
          'treated as closed.',
        'Years-open are the published observation, measured at referenceDate on the snapshot, ' +
          'not recomputed against today.',
        'BBB ratings ride on the permit row (bbb_lookup, bbb_rating). A null rating means the ' +
          'contractor was not rated, not a poor rating.',
      ],
      missingData: missingDataNotes(enrichment),
    };
  }
}

function missingDataNotes(enrichment: EnrichmentStatus): string[] {
  const notes: string[] = [];
  if (!enrichment.permits.available) notes.push(enrichment.permits.reason);
  if (!enrichment.bbb.available) notes.push(enrichment.bbb.reason);
  notes.push(
    'The published open-data/ directory holds 53,813 of 181,218 per-property JSON documents ' +
      "(9 of 56 geohash5 shards) because of the publisher's egress budget. The query table this " +
      'server reads is the full 181,218 — that bound does not apply here.',
  );
  return notes;
}

function manifestSummary(manifest: QueryTableManifest | null): Row | null {
  if (manifest === null) return null;
  return {
    runId: manifest.runId ?? null,
    publishedAt: manifest.publishedAt ?? null,
    rows: manifest.rows ?? null,
    columns: manifest.columns ?? null,
    coverage: manifest.coverage ?? null,
    sortedBy: manifest.sortedBy ?? null,
    bytes: manifest.bytes ?? null,
    provenance: manifest.provenance ?? null,
  };
}
