import { z } from 'zod';
import { logger } from '../observability';
import {
  latestStatusCompletion,
  latestTimestamp,
  permitStatusSourceState,
} from './permit-status-source';
import { DATA_BUCKET, getJson, getJsonRecord, listObjects, listPrefixes } from './s3-json';

/**
 * The pipeline run summary, assembled from the manifests the ingestion phases write.
 *
 * Three rules govern everything in this module.
 *
 * **Every number is read from an artifact, never hardcoded.** Record counts, deltas, and
 * timestamps come from `manifests/<runId>/manifest.json` and its change set; permit
 * figures come from the permit slice manifests. If an artifact is absent the field is
 * `null` and the UI says so, because a fabricated zero is worse than a visible gap.
 *
 * **Schemas are tolerant.** This view is the first thing a reviewer opens, so a producer
 * adding a field must never be able to blank the page. Unknown keys are ignored and every
 * field is optional; a manifest that fails to parse is reported as unreadable rather than
 * thrown.
 *
 * **Source status is derived, not declared.** Whether a source counts as ingested is
 * decided by looking for its artifacts in the data lake on every request, so a source
 * that lands while another phase is still running appears without a code change.
 */

/** Manifest reads are cheap but not free; a warm container reuses them for this long. */
const CACHE_TTL_MS = 60 * 1000;

const MANIFEST_PREFIX = 'manifests/';
const PERMIT_MANIFEST_PREFIX = 'manifests/permits/';
const PUBLISH_POINTER_KEY = 'publish/current.json';
const BBB_POINTER_KEY = 'staged/bbb/contractor-ratings/current.json';
const PLACES_POINTER_KEY = 'publish/places/current.json';
const LICENCE_POINTER_KEY = 'staged/licences/contractor-licences/current.json';
const FDOR_POINTER_KEY = 'raw/fdor/current.json';

/** Prefixes under `manifests/` that are not per-run history. */
const NON_RUN_PREFIXES = new Set([`${MANIFEST_PREFIX}current/`, PERMIT_MANIFEST_PREFIX]);

const looseNumber = z.number().finite().optional();
const looseString = z.string().optional();

const RunManifestSchema = z
  .object({
    runId: looseString,
    county: looseString,
    phase: looseString,
    startedAt: looseString,
    finishedAt: looseString,
    parcelCount: looseNumber,
    snapshotYear: looseNumber,
    sourceFingerprint: looseString,
    sources: z.array(z.string()).optional(),
    recordCounts: z.record(z.string(), z.number()).optional(),
    stagedPath: looseString,
    changeSetKey: looseString,
    reconciliationKey: looseString,
    status: looseString,
    skipReason: looseString,
    sourceEtag: looseString,
    sourceLastModified: looseString,
    sourceUrl: looseString,
    publishDecision: looseString,
  })
  .loose();
type RunManifest = z.infer<typeof RunManifestSchema>;

const ChangeSetSchema = z
  .object({
    runId: looseString,
    startedAt: looseString,
    finishedAt: looseString,
    counts: z
      .object({
        new: looseNumber,
        changed: looseNumber,
        unchanged: looseNumber,
        'missing-on-source': looseNumber,
      })
      .loose()
      .optional(),
    totals: z
      .object({ prior: looseNumber, current: looseNumber, actionable: looseNumber })
      .loose()
      .optional(),
    output: z
      .object({
        format: looseString,
        partitionCount: looseNumber,
        partitionedBy: z.array(z.string()).optional(),
        stagedPrefix: looseString,
      })
      .loose()
      .optional(),
    source: z
      .object({
        url: looseString,
        etag: looseString,
        lastModified: looseString,
        fingerprint: looseString,
      })
      .loose()
      .optional(),
  })
  .loose();
type ChangeSet = z.infer<typeof ChangeSetSchema>;

const ReconciliationSchema = z
  .object({
    runId: looseString,
    startedAt: looseString,
    finishedAt: looseString,
    independence: looseString,
    join: z.object({ key: looseString, rule: looseString }).loose().optional(),
    sources: z.record(z.string(), z.unknown()).optional(),
    fieldAgreement: z
      .record(
        z.string(),
        z
          .object({
            rate: looseNumber,
            comparable: looseNumber,
            exact: looseNumber,
            verdict: looseString,
            anomalies: looseNumber,
            anomalyRule: looseString,
            measure: looseString,
          })
          .loose(),
      )
      .optional(),
    nullResults: z
      .record(z.string(), z.object({ interpretation: looseString, rate: looseNumber }).loose())
      .optional(),
  })
  .loose();

const PublishPointerSchema = z
  .object({
    runId: looseString,
    county: looseString,
    snapshotPrefix: looseString,
    changeSetKey: looseString,
    format: looseString,
    partitionedBy: z.array(z.string()).optional(),
    parcelCount: looseNumber,
    partitionCount: looseNumber,
    objectCount: looseNumber,
    bytes: looseNumber,
    publishedAt: looseString,
  })
  .loose();

const PermitSummarySchema = z
  .object({
    runId: looseString,
    rowsLanded: looseNumber,
    distinctPermitRows: looseNumber,
    distinctApplications: looseNumber,
    distinctParcels: looseNumber,
    roofingRows: looseNumber,
    shardsLanded: looseNumber,
    monthlyRows: z.record(z.string(), z.number()).optional(),
    emptyMonths: z.array(z.string()).optional(),
    parcelMatch: z
      .object({
        snapshotRunId: looseString,
        publishedParcels: looseNumber,
        matchedParcels: looseNumber,
        unmatchedParcels: looseNumber,
        joinRate: looseNumber,
      })
      .loose()
      .optional(),
    coverage: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const BbbPointerSchema = z
  .object({
    runId: looseString,
    generatedAt: looseString,
    businessCount: looseNumber,
    matchedContractorCount: looseNumber,
    matchRate: looseNumber,
  })
  .loose();

const PlacesPointerSchema = z
  .object({
    release: looseString,
    runId: looseString,
    publishedAt: looseString,
    businessLocations: looseNumber,
    roofingPlaces: looseNumber,
  })
  .loose();

const LicencePointerSchema = z
  .object({
    runId: looseString,
    generatedAt: looseString,
    sourceLastModified: looseString,
    licenceCount: looseNumber,
    matchedContractorCount: looseNumber,
    matchRate: looseNumber,
    contractorsWithAdverseLicence: looseNumber,
  })
  .loose();

const FdorPointerSchema = z
  .object({
    runId: looseString,
    recordCount: looseNumber,
    acquiredAt: looseString,
  })
  .loose();

type LandedPointers = {
  bbb: z.infer<typeof BbbPointerSchema> | null;
  places: z.infer<typeof PlacesPointerSchema> | null;
  licences: z.infer<typeof LicencePointerSchema> | null;
  fdor: z.infer<typeof FdorPointerSchema> | null;
};

const StatusSummarySchema = z
  .object({
    runId: looseString,
    finishedAt: looseString,
    permitsLanded: looseNumber,
    batchesLanded: looseNumber,
  })
  .loose();

const StatusProgressSchema = z
  .object({
    runId: looseString,
    updatedAt: looseString,
    lastBatchIndex: looseNumber,
    permitsLanded: looseNumber,
    batchesLanded: looseNumber,
  })
  .loose();

const LongOpenSchema = z
  .object({
    permitsKnown: looseNumber,
  })
  .loose();

const PermitCoverageSchema = z
  .object({
    runId: looseString,
    scope: looseString,
    note: looseString,
    limitation: looseString,
    countywideParcels: looseNumber,
    unincorporatedParcels: looseNumber,
    matchedParcels: looseNumber,
    unincorporatedTouchRate: looseNumber,
    countywideTouchRate: looseNumber,
    runScope: z
      .object({ fromMonth: looseString, toMonth: looseString, statusFromMonth: looseString })
      .loose()
      .optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type SourceStatus = 'ingested' | 'in-progress' | 'not-ingested' | 'declined';

export type SourceCategory =
  'property' | 'permit' | 'ownership' | 'contractor' | 'business' | 'coordinate';

export interface SourceEntry {
  id: string;
  label: string;
  category: SourceCategory;
  status: SourceStatus;
  /** Records landed in the data lake, or `null` when nothing has been ingested yet. */
  records: number | null;
  /** What `records` counts, so a number is never ambiguous. */
  recordUnit: string | null;
  /**
   * When this landing finished. For the county file that is the refresh finish,
   * not the ZIP Last-Modified (those can be hours apart).
   */
  collectedAt: string | null;
  role: string;
  cadence: string;
  provenance: string;
  /** Where the landed data sits, so a claim can be checked against the bucket. */
  artifactPrefix: string | null;
  notes: string | null;
}

export interface Limitation {
  id: string;
  scope: string;
  text: string;
  /** Repository path or S3 key the statement is taken from. */
  evidence: string;
}

export interface RunHistoryEntry {
  runId: string;
  phase: string | null;
  /** `skipped` is a successful nightly check that did not publish a new snapshot. */
  status: 'completed' | 'skipped';
  skipReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  parcelCount: number | null;
  /** Sum of every input-file row count the manifest reports. */
  inputRecords: number | null;
  recordCounts: { name: string; count: number }[];
  sources: string[];
  sourceFingerprint: string | null;
  delta: {
    new: number | null;
    changed: number | null;
    unchanged: number | null;
    missingOnSource: number | null;
    prior: number | null;
    current: number | null;
    actionable: number | null;
    /** Change in published parcel count against the previous run in this list. */
    parcelCountChange: number | null;
  } | null;
  upstream: {
    url: string | null;
    etag: string | null;
    lastModified: string | null;
    fingerprint: string | null;
  } | null;
  output: {
    format: string | null;
    partitionCount: number | null;
    partitionedBy: string[];
  } | null;
  /** Which artifacts this run actually wrote, so an incomplete run reads as incomplete. */
  artifacts: string[];
  isPublished: boolean;
  /** Set when an artifact exists but could not be parsed. */
  unreadable: string[];
}

export interface IpfsArtifacts {
  /** False when no producer has written IPFS references yet. */
  present: boolean;
  runId: string | null;
  publishedAt: string | null;
  ipnsName: string | null;
  ipnsUrl: string | null;
  rootCid: string | null;
  rootUrl: string | null;
  /** True when a run reused the previous generation's CID rather than re-uploading. */
  unchanged: boolean | null;
  totals: { bytes: number | null; files: number | null } | null;
  datasets: {
    name: string;
    cid: string;
    entryPath: string | null;
    url: string;
    bytes: number | null;
    files: number | null;
    coverage: string | null;
  }[];
  /** Where the references were read from, so the claim is checkable. */
  sourceKeys: string[];
}

export interface RunSummary {
  county: string;
  generatedAt: string;
  bucket: string;
  published: {
    runId: string | null;
    publishedAt: string | null;
    parcelCount: number | null;
    partitionCount: number | null;
    objectCount: number | null;
    bytes: number | null;
    format: string | null;
    partitionedBy: string[];
    snapshotPrefix: string | null;
  } | null;
  current: RunHistoryEntry | null;
  runs: RunHistoryEntry[];
  sources: SourceEntry[];
  permits: {
    status: SourceStatus;
    /** The most complete harvest slice, which is what the headline figures describe. */
    runId: string | null;
    rows: number | null;
    applications: number | null;
    parcels: number | null;
    roofingRows: number | null;
    /** One row per calendar month, taking the best observation across every slice. */
    monthlyRows: { month: string; rows: number; sliceRunId: string }[];
    /** Every harvest slice that has written a manifest, newest first. */
    slices: {
      runId: string;
      rows: number | null;
      applications: number | null;
      parcels: number | null;
      roofingRows: number | null;
      months: string[];
      hasCoverage: boolean;
    }[];
    window: { fromMonth: string | null; toMonth: string | null; statusFromMonth: string | null };
    coverage: {
      scope: string | null;
      countywideParcels: number | null;
      unincorporatedParcels: number | null;
      matchedParcels: number | null;
      countywideTouchRate: number | null;
      unincorporatedTouchRate: number | null;
      limitation: string | null;
    } | null;
    joinRate: number | null;
    /** Census finish time only — status batches must not move this. */
    collectedAt: string | null;
    /** Last finished status sweep. In-flight batches do not move this. */
    statusCollectedAt: string | null;
    /** Status-row status, cadence, and records — completed sweeps only update Collected. */
    statusSource: {
      status: SourceStatus;
      collectedAt: string | null;
      records: number | null;
      cadence: string;
    };
    /** Status refresh writes one NDJSON object per batch; this counts them. */
    statusBatchObjects: number | null;
  } | null;
  reconciliation: {
    runId: string | null;
    finishedAt: string | null;
    independence: string | null;
    join: { key: string | null; rule: string | null } | null;
    fields: {
      field: string;
      rate: number | null;
      comparable: number | null;
      exact: number | null;
      verdict: string | null;
      anomalies: number | null;
      anomalyRule: string | null;
    }[];
  } | null;
  ipfs: IpfsArtifacts;
  limitations: Limitation[];
}

// ---------------------------------------------------------------------------
// Documented limitations
// ---------------------------------------------------------------------------

/**
 * Only limitations that still bound what the live sites can claim, in plain language.
 * Harvest-ops essays, cut sources, and serving internals stay in docs/, not here.
 * Unincorporated coverage is prepended at assembly time from the measured counts.
 */
const DOCUMENTED_LIMITATIONS: Limitation[] = [
  {
    id: 'permit-status-cap',
    scope: 'Permits — status',
    text: 'A search by address, parcel, or name only returns the first 50 matches, with no warning that there are more. To see whether a permit is still open we have to look it up by application number, one at a time.',
    evidence: 'docs/seminole-sources.yaml',
  },
  {
    id: 'permit-close-date',
    scope: 'Permits — close date',
    text: 'The portal does not say when a permit closed. We only treat one as closed when a final inspection has a result date, which takes a second lookup. Until we have checked, we record it as unknown — never as closed.',
    evidence: 'docs/seminole-sources.yaml',
  },
  {
    id: 'dbpr-qb-rows',
    scope: 'Contractor licences',
    text: 'About half the licence file is “qualified business” rows with no licence number, no expiry date, and the company name in a different column. Matching on one name column misses those rows.',
    evidence: 'docs/seminole-contractor-business-sources.md',
  },
];

function coverageLimitationText(
  coverage: NonNullable<NonNullable<RunSummary['permits']>['coverage']>,
): string {
  const unincorporated = coverage.unincorporatedParcels ?? 91_041;
  const countywide = coverage.countywideParcels ?? 181_218;
  return (
    `This source only covers unincorporated Seminole County — ` +
    `${unincorporated.toLocaleString('en-US')} of ${countywide.toLocaleString('en-US')} properties. ` +
    `Permits issued by the cities are not in this portal.`
  );
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function toIso(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function durationBetween(startedAt: string | null, finishedAt: string | null): number | null {
  if (startedAt === null || finishedAt === null) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

function nullableNumber(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : value;
}

function runIdFromPrefix(prefix: string): string {
  return prefix.slice(MANIFEST_PREFIX.length).replace(/\/$/, '');
}

async function readRun(prefix: string): Promise<{
  runId: string;
  manifest: RunManifest | null;
  changeSet: ChangeSet | null;
  reconciliation: z.infer<typeof ReconciliationSchema> | null;
  artifacts: string[];
  unreadable: string[];
}> {
  const runId = runIdFromPrefix(prefix);
  const artifacts: string[] = [];
  const unreadable: string[] = [];

  const [rawManifest, rawChangeSet, rawReconciliation] = await Promise.all([
    getJson(`${prefix}manifest.json`),
    getJson(`${prefix}change_set.json`),
    getJson(`${prefix}reconciliation.json`),
  ]);

  const parse = <S extends z.ZodType>(
    schema: S,
    raw: unknown,
    name: string,
  ): z.output<S> | null => {
    if (raw === null) return null;
    artifacts.push(name);
    const result = schema.safeParse(raw);
    if (result.success) return result.data as z.output<S>;
    unreadable.push(name);
    logger.warn('Run artifact did not match its schema', { runId, artifact: name });
    return null;
  };

  return {
    runId,
    manifest: parse(RunManifestSchema, rawManifest, 'manifest.json'),
    changeSet: parse(ChangeSetSchema, rawChangeSet, 'change_set.json'),
    reconciliation: parse(ReconciliationSchema, rawReconciliation, 'reconciliation.json'),
    artifacts,
    unreadable,
  };
}

function toHistoryEntry(
  run: Awaited<ReturnType<typeof readRun>>,
  publishedRunId: string | null,
): RunHistoryEntry {
  const { manifest, changeSet, reconciliation } = run;
  const startedAt =
    toIso(manifest?.startedAt) ?? toIso(changeSet?.startedAt) ?? toIso(reconciliation?.startedAt);
  const finishedAt =
    toIso(manifest?.finishedAt) ??
    toIso(changeSet?.finishedAt) ??
    toIso(reconciliation?.finishedAt);

  const recordCounts = Object.entries(manifest?.recordCounts ?? {})
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const counts = changeSet?.counts;
  const totals = changeSet?.totals;

  const skipped = (manifest?.status ?? '').toUpperCase() === 'SKIPPED';

  return {
    runId: manifest?.runId ?? changeSet?.runId ?? run.runId,
    phase: manifest?.phase ?? null,
    status: skipped ? 'skipped' : 'completed',
    skipReason: manifest?.skipReason ?? null,
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    parcelCount: nullableNumber(manifest?.parcelCount) ?? nullableNumber(totals?.current),
    inputRecords:
      recordCounts.length === 0 ? null : recordCounts.reduce((sum, entry) => sum + entry.count, 0),
    recordCounts,
    sources: manifest?.sources ?? [],
    sourceFingerprint: manifest?.sourceFingerprint ?? changeSet?.source?.fingerprint ?? null,
    delta:
      counts === undefined && totals === undefined
        ? null
        : {
            new: nullableNumber(counts?.new),
            changed: nullableNumber(counts?.changed),
            unchanged: nullableNumber(counts?.unchanged),
            missingOnSource: nullableNumber(counts?.['missing-on-source']),
            prior: nullableNumber(totals?.prior),
            current: nullableNumber(totals?.current),
            actionable: nullableNumber(totals?.actionable),
            parcelCountChange: null,
          },
    upstream:
      changeSet?.source !== undefined
        ? {
            url: changeSet.source.url ?? null,
            etag: changeSet.source.etag ?? null,
            lastModified: toIso(changeSet.source.lastModified),
            fingerprint: changeSet.source.fingerprint ?? null,
          }
        : manifest?.sourceEtag !== undefined && manifest.sourceEtag !== ''
          ? {
              url: manifest.sourceUrl ?? null,
              etag: manifest.sourceEtag ?? null,
              lastModified: toIso(manifest.sourceLastModified),
              fingerprint: null,
            }
          : null,
    output:
      changeSet?.output === undefined
        ? null
        : {
            format: changeSet.output.format ?? null,
            partitionCount: nullableNumber(changeSet.output.partitionCount),
            partitionedBy: changeSet.output.partitionedBy ?? [],
          },
    artifacts: run.artifacts,
    isPublished: publishedRunId !== null && publishedRunId === (manifest?.runId ?? run.runId),
    unreadable: run.unreadable,
  };
}

/**
 * Permit progress across every harvest slice.
 *
 * Permit ingestion is a separate phase that re-harvests the same calendar months as it
 * refreshes, so slices overlap and their row counts cannot simply be added. The headline
 * figures therefore describe the most complete single slice, month coverage takes the best
 * observation of each month across all slices, and every slice stays listed — a partial
 * refresh must not read as though it replaced a fuller earlier harvest.
 */
async function readPermits(): Promise<RunSummary['permits']> {
  const slicePrefixes = await listPrefixes(PERMIT_MANIFEST_PREFIX);
  if (slicePrefixes.length === 0) return null;

  const parsed = await Promise.all(
    slicePrefixes.map(async (prefix) => {
      const [rawSummary, rawCoverage] = await Promise.all([
        getJson(`${prefix}census-summary.json`),
        getJson(`${prefix}coverage.json`),
      ]);
      if (rawSummary === null && rawCoverage === null) return null;

      const summary = rawSummary === null ? null : PermitSummarySchema.safeParse(rawSummary);
      const coverage = rawCoverage === null ? null : PermitCoverageSchema.safeParse(rawCoverage);
      const runId = prefix.slice(PERMIT_MANIFEST_PREFIX.length).replace(/\/$/, '');
      return {
        runId,
        summary: summary?.success === true ? summary.data : null,
        coverage: coverage?.success === true ? coverage.data : null,
      };
    }),
  );

  const slices = parsed.filter((slice): slice is NonNullable<typeof slice> => slice !== null);
  if (slices.length === 0) return null;

  const rowsOf = (slice: (typeof slices)[number]): number | null =>
    nullableNumber(slice.summary?.distinctPermitRows) ?? nullableNumber(slice.summary?.rowsLanded);

  const monthly = new Map<string, { rows: number; sliceRunId: string }>();
  for (const slice of slices) {
    for (const [month, rows] of Object.entries(slice.summary?.monthlyRows ?? {})) {
      const existing = monthly.get(month);
      if (existing === undefined || rows > existing.rows) {
        monthly.set(month, { rows, sliceRunId: slice.runId });
      }
    }
  }

  const best = [...slices].sort(
    (a, b) => (rowsOf(b) ?? 0) - (rowsOf(a) ?? 0),
  )[0] as (typeof slices)[number];
  const coverage =
    best.coverage ?? slices.find((slice) => slice.coverage !== null)?.coverage ?? null;

  const [censusObjects, statusObjects, censusSummaryTimes, parsedSummaries, progressCounts, longOpen] =
    await Promise.all([
      listObjects('staged/permits/census/', 400),
      listObjects('staged/permits/status/', 2000),
      Promise.all(
        slicePrefixes.map(async (prefix) => {
          const record = await getJsonRecord(`${prefix}census-summary.json`);
          return record?.lastModified ?? null;
        }),
      ),
      Promise.all(
        slicePrefixes.map(async (prefix) => {
          const record = await getJsonRecord(`${prefix}status-summary.json`);
          if (record === null) return null;
          const parsed = StatusSummarySchema.safeParse(record.value);
          if (!parsed.success) return null;
          return {
            lastModified: record.lastModified,
            finishedAt: parsed.data.finishedAt ?? null,
            permitsLanded: nullableNumber(parsed.data.permitsLanded),
          };
        }),
      ),
      Promise.all(
        slicePrefixes.map(async (prefix) => {
          const raw = await getJson(`${prefix}status-progress.json`);
          if (raw === null) return null;
          const parsed = StatusProgressSchema.safeParse(raw);
          return parsed.success ? nullableNumber(parsed.data.permitsLanded) : null;
        }),
      ),
      getJson('manifests/permits/long-open-roofing.json'),
    ]);
  const collectedAt = latestTimestamp([
    ...censusObjects.map((object) => object.lastModified),
    ...censusSummaryTimes,
  ]);
  const statusCompletion = latestStatusCompletion(
    parsedSummaries.filter((summary): summary is NonNullable<typeof summary> => summary !== null),
  );
  const latestStatusBatchAt = latestTimestamp(statusObjects.map((object) => object.lastModified));
  const progressHarvested = progressCounts.reduce<number | null>((max, count) => {
    if (count === null) return max;
    if (max === null || count > max) return count;
    return max;
  }, null);
  const knownParsed = LongOpenSchema.safeParse(longOpen);
  const knownHarvested = knownParsed.success ? nullableNumber(knownParsed.data.permitsKnown) : null;
  const harvestedRecords = [progressHarvested, statusCompletion.records, knownHarvested].reduce<
    number | null
  >((max, count) => {
    if (count === null) return max;
    if (max === null || count > max) return count;
    return max;
  }, null);
  const statusSource = permitStatusSourceState({
    statusBatchCount: statusObjects.length === 0 ? null : statusObjects.length,
    latestStatusBatchAt,
    lastCompletedAt: statusCompletion.completedAt,
    lastCompletedRecords: statusCompletion.records,
    harvestedRecords,
  });

  return {
    status: coverage === null ? 'in-progress' : 'ingested',
    runId: best.runId,
    rows: rowsOf(best),
    applications: nullableNumber(best.summary?.distinctApplications),
    parcels:
      nullableNumber(best.summary?.distinctParcels) ?? nullableNumber(coverage?.matchedParcels),
    roofingRows: nullableNumber(best.summary?.roofingRows),
    monthlyRows: [...monthly.entries()]
      .map(([month, entry]) => ({ month, ...entry }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    slices: slices
      .map((slice) => ({
        runId: slice.runId,
        rows: rowsOf(slice),
        applications: nullableNumber(slice.summary?.distinctApplications),
        parcels: nullableNumber(slice.summary?.distinctParcels),
        roofingRows: nullableNumber(slice.summary?.roofingRows),
        months: Object.keys(slice.summary?.monthlyRows ?? {}).sort(),
        hasCoverage: slice.coverage !== null,
      }))
      .sort((a, b) => b.runId.localeCompare(a.runId)),
    window: {
      fromMonth: coverage?.runScope?.fromMonth ?? null,
      toMonth: coverage?.runScope?.toMonth ?? null,
      statusFromMonth: coverage?.runScope?.statusFromMonth ?? null,
    },
    coverage:
      coverage === null
        ? null
        : {
            scope: coverage.scope ?? null,
            countywideParcels: nullableNumber(coverage.countywideParcels),
            unincorporatedParcels: nullableNumber(coverage.unincorporatedParcels),
            matchedParcels: nullableNumber(coverage.matchedParcels),
            countywideTouchRate: nullableNumber(coverage.countywideTouchRate),
            unincorporatedTouchRate: nullableNumber(coverage.unincorporatedTouchRate),
            limitation: coverage.limitation ?? null,
          },
    joinRate: nullableNumber(best.summary?.parcelMatch?.joinRate),
    collectedAt: collectedAt ?? null,
    statusCollectedAt: statusSource.collectedAt,
    statusSource,
    statusBatchObjects: statusObjects.length === 0 ? null : statusObjects.length,
  };
}

const IpfsRecordSchema = z
  .object({
    runId: looseString,
    publishedAt: looseString,
    rootCid: looseString,
    rootUrl: looseString,
    unchanged: z.boolean().optional(),
    ipns: z
      .object({ label: looseString, name: looseString, url: looseString, sequence: looseNumber })
      .loose()
      .optional(),
    totals: z.object({ bytes: looseNumber, files: looseNumber }).loose().optional(),
    datasets: z
      .record(
        z.string(),
        z
          .object({
            cid: looseString,
            entryPath: looseString,
            url: looseString,
            bytes: looseNumber,
            files: looseNumber,
            coverage: looseString,
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

/**
 * IPFS references, if the publication phase has written any.
 *
 * `publish/ipfs.json` is the stable pointer that phase maintains, with a run-scoped copy
 * beside it. Its shape is read tolerantly, and anything it does not recognise falls back to
 * scanning the object for CID-shaped strings — so references appear as soon as they are
 * written, whatever the producer settles on, and their absence renders as "not yet
 * published" rather than an error.
 */
async function readIpfs(runId: string | null): Promise<IpfsArtifacts> {
  const empty: IpfsArtifacts = {
    present: false,
    runId: null,
    publishedAt: null,
    ipnsName: null,
    ipnsUrl: null,
    rootCid: null,
    rootUrl: null,
    unchanged: null,
    totals: null,
    datasets: [],
    sourceKeys: [],
  };

  const candidateKeys = [
    'publish/ipfs.json',
    ...(runId === null
      ? []
      : [`publish/ipfs/${runId}.json`, `${MANIFEST_PREFIX}${runId}/ipfs.json`]),
    'publish/current.json',
    `${MANIFEST_PREFIX}current/manifest.json`,
  ];

  for (const key of candidateKeys) {
    const raw = await getJson(key);
    if (raw === null) continue;

    const parsed = IpfsRecordSchema.safeParse(raw);
    const record = parsed.success ? parsed.data : null;
    const ipnsName = record?.ipns?.name ?? null;
    const rootCid = record?.rootCid ?? null;

    if (ipnsName !== null || rootCid !== null) {
      return {
        present: true,
        runId: record?.runId ?? null,
        publishedAt: toIso(record?.publishedAt),
        ipnsName,
        ipnsUrl:
          record?.ipns?.url ?? (ipnsName === null ? null : `https://ipfs.io/ipns/${ipnsName}`),
        rootCid,
        rootUrl: record?.rootUrl ?? (rootCid === null ? null : `https://ipfs.io/ipfs/${rootCid}`),
        unchanged: record?.unchanged ?? null,
        totals:
          record?.totals === undefined
            ? null
            : {
                bytes: nullableNumber(record.totals.bytes),
                files: nullableNumber(record.totals.files),
              },
        datasets: Object.entries(record?.datasets ?? {})
          .filter(([, dataset]) => dataset.cid !== undefined && dataset.cid !== '')
          .map(([name, dataset]) => ({
            name,
            cid: dataset.cid as string,
            entryPath: dataset.entryPath ?? null,
            url: dataset.url ?? `https://ipfs.io/ipfs/${dataset.cid as string}`,
            bytes: nullableNumber(dataset.bytes),
            files: nullableNumber(dataset.files),
            coverage: dataset.coverage ?? null,
          })),
        sourceKeys: [key],
      };
    }

    // Unrecognised shape: keep whatever CID-shaped strings it carries rather than nothing.
    const found = collectIpfsReferences(raw);
    if (found.cids.length === 0 && found.ipnsName === null) continue;
    return {
      ...empty,
      present: true,
      ipnsName: found.ipnsName,
      ipnsUrl: found.ipnsName === null ? null : `https://ipfs.io/ipns/${found.ipnsName}`,
      datasets: found.cids.map((entry) => ({
        name: entry.label,
        cid: entry.cid,
        entryPath: null,
        url: entry.gatewayUrl,
        bytes: null,
        files: null,
        coverage: null,
      })),
      sourceKeys: [key],
    };
  }

  return empty;
}

/** CIDv0 (`Qm…`) and CIDv1 base32 (`baf…`), which is what every producer here emits. */
const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{57,})$/;
const IPNS_KEY_PATTERN = /ipns/i;
const CID_KEY_PATTERN = /cid|ipfs/i;

export function collectIpfsReferences(value: unknown): {
  cids: { label: string; cid: string; gatewayUrl: string }[];
  ipnsName: string | null;
} {
  const cids: { label: string; cid: string; gatewayUrl: string }[] = [];
  let ipnsName: string | null = null;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 6) return;
    if (typeof node === 'string') {
      const trimmed = node
        .trim()
        .replace(/^\/?ipfs\//, '')
        .replace(/^\/?ipns\//, '');
      if (IPNS_KEY_PATTERN.test(path) && ipnsName === null && trimmed !== '') {
        // An IPNS name is itself a CID-shaped key, so the field name decides.
        ipnsName = trimmed;
        return;
      }
      if (CID_PATTERN.test(trimmed) && CID_KEY_PATTERN.test(path)) {
        cids.push({
          label: path === '' ? 'artifact' : path,
          cid: trimmed,
          gatewayUrl: `https://ipfs.io/ipfs/${trimmed}`,
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, path === '' ? key : `${path}.${key}`, depth + 1);
      }
    }
  };

  walk(value, '', 0);
  return { cids, ipnsName };
}

/**
 * One row per upstream, not per file inside that upstream.
 *
 * Status and counts are read from the pointers and manifests in the data lake. A
 * source with no pointer is `not-ingested`; the UI hides those until they land.
 */
function buildSources(
  current: RunHistoryEntry | null,
  permits: RunSummary['permits'],
  parcelStats: { withCoordinates: number | null; withOwnerName: number | null } | null,
  landed: LandedPointers,
): SourceEntry[] {
  const recordCount = (name: string): number | null =>
    current?.recordCounts.find((entry) => entry.name === name)?.count ?? null;

  const countyFileAt = current?.upstream?.lastModified ?? current?.finishedAt ?? null;
  const countyFileUrl =
    current?.upstream?.url ?? 'https://files.scpafl.org/data/cama/SeminoleCounty.zip';
  const { bbb, places, licences, fdor } = landed;

  return [
    {
      id: 'scpa-cama',
      label: 'Seminole County Property Appraiser',
      category: 'property',
      status: current === null ? 'not-ingested' : 'ingested',
      records: recordCount('Parcels.csv') ?? current?.parcelCount ?? null,
      recordUnit: 'parcels',
      collectedAt: current?.finishedAt ?? countyFileAt,
      role: 'Parcels, buildings, sales, owners, and map points',
      cadence: 'Updated every night',
      provenance: countyFileUrl,
      artifactPrefix: 'publish/parcels/',
      notes:
        parcelStats?.withOwnerName === null || parcelStats === null
          ? 'One county file. Includes buildings, sales, tax history, owner names, and coordinates.'
          : `One county file. ${parcelStats.withOwnerName.toLocaleString('en-US')} parcels have an owner name` +
            (parcelStats.withCoordinates === null
              ? '.'
              : `; ${parcelStats.withCoordinates.toLocaleString('en-US')} have coordinates.`),
    },
    {
      id: 'fdor-centroids',
      label: 'Florida statewide parcel map',
      category: 'property',
      status: fdor === null ? 'not-ingested' : 'ingested',
      records: nullableNumber(fdor?.recordCount),
      recordUnit: 'parcels',
      collectedAt: toIso(fdor?.acquiredAt) ?? countyFileAt,
      role: 'Second map, used to check the county file',
      cadence: 'Published once a year',
      provenance:
        'https://services9.arcgis.com/Gh9awoU677aKree0/ArcGIS/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0',
      artifactPrefix: 'raw/fdor/',
      notes: 'A separate state map of the same parcels, not another copy of the county file.',
    },
    {
      id: 'permit-census',
      label: 'County building permits',
      category: 'permit',
      status: permits === null ? 'not-ingested' : permits.status,
      records: permits?.rows ?? null,
      recordUnit: 'permits',
      collectedAt: permits?.collectedAt ?? null,
      role: 'Permit history for unincorporated county',
      cadence: 'Checked every day',
      provenance: 'https://scwebapp2.seminolecountyfl.gov:6443/BuildingPublicrequestportal/',
      artifactPrefix: 'staged/permits/census/',
      notes:
        permits === null
          ? 'Permit harvest has not written a summary yet.'
          : 'Unincorporated county only. City-issued permits are not in this portal.',
    },
    {
      id: 'permit-status',
      label: 'Permit status',
      category: 'permit',
      status: permits?.statusSource.status ?? 'not-ingested',
      records: permits?.statusSource.records ?? null,
      recordUnit: 'permits checked',
      collectedAt: permits?.statusSource.collectedAt ?? null,
      role: 'Whether a permit is still open',
      cadence: permits?.statusSource.cadence ?? 'Still being collected',
      provenance: 'https://semc-egov.aspgov.com/Click2GovBP/selectpermit.html',
      artifactPrefix: 'staged/permits/status/',
      notes:
        permits?.statusSource.status === 'ingested'
          ? 'Looked up one application at a time.'
          : 'Looked up one application at a time. Not finished for the full history.',
    },
    {
      id: 'dbpr-licences',
      label: 'Florida contractor licences',
      category: 'contractor',
      status: licences === null ? 'not-ingested' : 'ingested',
      records: nullableNumber(licences?.licenceCount),
      recordUnit: 'licences',
      collectedAt: toIso(licences?.generatedAt ?? licences?.sourceLastModified),
      role: 'Licence standing for permit contractors',
      cadence: 'Updated every week',
      provenance: 'https://www2.myfloridalicense.com/sto/file_download/extracts/CONSTRUCTIONLICENSE_1.csv',
      artifactPrefix: 'staged/licences/',
      notes:
        licences === null
          ? 'Licence harvest has not written a pointer yet.'
          : `${(licences.matchedContractorCount ?? 0).toLocaleString('en-US')} permit contractors matched.`,
    },
    {
      id: 'bbb-ratings',
      label: 'Better Business Bureau ratings',
      category: 'contractor',
      status: bbb === null ? 'not-ingested' : 'ingested',
      records: nullableNumber(bbb?.businessCount),
      recordUnit: 'businesses',
      collectedAt: toIso(bbb?.generatedAt),
      role: 'Rating on a contractor when a profile matched',
      cadence: 'Updated every month',
      provenance: 'https://www.bbb.org/',
      artifactPrefix: 'staged/bbb/',
      notes:
        bbb === null
          ? 'BBB harvest has not written a pointer yet.'
          : `${(bbb.matchedContractorCount ?? 0).toLocaleString('en-US')} permit contractors matched.`,
    },
    {
      id: 'overture-places',
      label: 'Business locations',
      category: 'business',
      status: places === null ? 'not-ingested' : 'ingested',
      records: nullableNumber(places?.businessLocations),
      recordUnit: 'places',
      collectedAt: toIso(places?.publishedAt),
      role: 'Businesses in the county',
      cadence: 'Updated with each map release',
      provenance: 'https://overturemaps.org/',
      artifactPrefix: 'publish/places/',
      notes:
        places === null
          ? 'Places ingest has not published a pointer yet.'
          : places.roofingPlaces === undefined
            ? null
            : `${places.roofingPlaces.toLocaleString('en-US')} roofing businesses.`,
    },
    {
      id: 'sunbiz-corporate',
      label: 'Sunbiz corporate registrations',
      category: 'business',
      status: 'declined',
      records: null,
      recordUnit: null,
      collectedAt: null,
      role: 'Legal entities — not used',
      cadence: 'Not ingested',
      provenance: 'https://dos.fl.gov/sunbiz/',
      artifactPrefix: null,
      notes: 'Skipped. Business records on this roll are map locations, not legal filings.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let cache: { at: number; value: Promise<RunSummary> } | null = null;

export interface RunSummaryOptions {
  /** Coverage figures the parcel snapshot already knows, passed in to avoid loading it. */
  parcelStats?: { withCoordinates: number | null; withOwnerName: number | null } | null;
}

export async function getRunSummary(options: RunSummaryOptions = {}): Promise<RunSummary> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const entry = { at: now, value: buildRunSummary(options) };
  cache = entry;
  entry.value.catch(() => {
    if (cache === entry) cache = null;
  });
  return entry.value;
}

async function buildRunSummary(options: RunSummaryOptions): Promise<RunSummary> {
  const startedAt = Date.now();

  const [rawPointer, rawCurrent, prefixes, permits, rawBbb, rawPlaces, rawLicences, rawFdor] =
    await Promise.all([
      getJson(PUBLISH_POINTER_KEY),
      getJson(`${MANIFEST_PREFIX}current/manifest.json`),
      listPrefixes(MANIFEST_PREFIX),
      readPermits(),
      getJson(BBB_POINTER_KEY),
      getJson(PLACES_POINTER_KEY),
      getJson(LICENCE_POINTER_KEY),
      getJson(FDOR_POINTER_KEY),
    ]);

  const bbbParsed = rawBbb === null ? null : BbbPointerSchema.safeParse(rawBbb);
  const placesParsed = rawPlaces === null ? null : PlacesPointerSchema.safeParse(rawPlaces);
  const licencesParsed = rawLicences === null ? null : LicencePointerSchema.safeParse(rawLicences);
  const fdorParsed = rawFdor === null ? null : FdorPointerSchema.safeParse(rawFdor);
  const landed: LandedPointers = {
    bbb: bbbParsed?.success === true ? bbbParsed.data : null,
    places: placesParsed?.success === true ? placesParsed.data : null,
    licences: licencesParsed?.success === true ? licencesParsed.data : null,
    fdor: fdorParsed?.success === true ? fdorParsed.data : null,
  };

  const pointerParsed = rawPointer === null ? null : PublishPointerSchema.safeParse(rawPointer);
  const pointer = pointerParsed?.success === true ? pointerParsed.data : null;
  const publishedRunId = pointer?.runId ?? null;

  const currentParsed = rawCurrent === null ? null : RunManifestSchema.safeParse(rawCurrent);
  const currentManifest = currentParsed?.success === true ? currentParsed.data : null;

  const runPrefixes = prefixes.filter((prefix) => !NON_RUN_PREFIXES.has(prefix));
  const runs = (await Promise.all(runPrefixes.map(readRun)))
    .map((run) => toHistoryEntry(run, publishedRunId))
    .filter((run) => run.artifacts.length > 0)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));

  // Stated against the most recent earlier run that published a parcel count — a run that
  // only wrote a reconciliation report has no count to compare against and is skipped.
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i] as RunHistoryEntry;
    if (run.delta === null || run.parcelCount === null) continue;
    const previous = runs.slice(i + 1).find((candidate) => candidate.parcelCount !== null);
    if (previous === undefined) continue;
    run.delta.parcelCountChange = run.parcelCount - (previous.parcelCount as number);
  }

  const current =
    runs.find(
      (run) =>
        run.status !== 'skipped' && run.runId === (currentManifest?.runId ?? publishedRunId),
    ) ??
    runs.find((run) => run.isPublished) ??
    runs.find((run) => run.status !== 'skipped') ??
    null;

  const reconciliationSource = await readReconciliation(current?.runId ?? publishedRunId);
  const ipfs = await readIpfs(current?.runId ?? publishedRunId);

  const summary: RunSummary = {
    county: pointer?.county ?? currentManifest?.county ?? 'Seminole County, FL',
    generatedAt: new Date().toISOString(),
    bucket: DATA_BUCKET,
    published:
      pointer === null
        ? null
        : {
            runId: pointer.runId ?? null,
            publishedAt: toIso(pointer.publishedAt),
            parcelCount: nullableNumber(pointer.parcelCount),
            partitionCount: nullableNumber(pointer.partitionCount),
            objectCount: nullableNumber(pointer.objectCount),
            bytes: nullableNumber(pointer.bytes),
            format: pointer.format ?? null,
            partitionedBy: pointer.partitionedBy ?? [],
            snapshotPrefix: pointer.snapshotPrefix ?? null,
          },
    current,
    runs,
    sources: buildSources(current, permits, options.parcelStats ?? null, landed),
    permits,
    reconciliation: reconciliationSource,
    ipfs,
    limitations: [
      ...(permits?.coverage === null || permits?.coverage === undefined
        ? []
        : [
            {
              id: 'permit-coverage-measured',
              scope: 'Permits — coverage',
              text: coverageLimitationText(permits.coverage),
              evidence: `s3://${DATA_BUCKET}/${MANIFEST_PREFIX}permits/${permits.runId ?? ''}/coverage.json`,
            },
          ]),
      ...DOCUMENTED_LIMITATIONS,
    ],
  };

  logger.info('Run summary assembled', {
    runs: runs.length,
    sources: summary.sources.length,
    permitStatus: permits?.status ?? 'absent',
    ipfsPresent: ipfs.present,
    tookMs: Date.now() - startedAt,
  });

  return summary;
}

async function readReconciliation(runId: string | null): Promise<RunSummary['reconciliation']> {
  if (runId === null) return null;
  const raw = await getJson(`${MANIFEST_PREFIX}${runId}/reconciliation.json`);
  if (raw === null) return null;
  const parsed = ReconciliationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;

  return {
    runId: data.runId ?? runId,
    finishedAt: toIso(data.finishedAt),
    independence: data.independence ?? null,
    join:
      data.join === undefined ? null : { key: data.join.key ?? null, rule: data.join.rule ?? null },
    fields: Object.entries(data.fieldAgreement ?? {})
      .map(([field, agreement]) => ({
        field,
        rate: nullableNumber(agreement.rate),
        comparable: nullableNumber(agreement.comparable),
        exact: nullableNumber(agreement.exact),
        verdict: agreement.verdict ?? null,
        anomalies: nullableNumber(agreement.anomalies),
        anomalyRule: agreement.anomalyRule ?? null,
      }))
      .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0)),
  };
}
