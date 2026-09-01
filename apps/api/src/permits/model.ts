/**
 * The permit tier's input and output contracts.
 *
 * Defined locally rather than in `@oracle-seminole/shared` because the shared package is
 * owned elsewhere. Nothing here is imported outside `src/permits/`.
 */
import { z } from 'zod';
import { DATA_HORIZON_YEAR } from './config';

/**
 * A real calendar date, not merely something shaped like one.
 *
 * The shape check alone accepts `1996-06-99`, which matters because the status planner uses a
 * `YYYY-MM-99` sentinel to sort applications whose issue date would not parse. That sentinel
 * is filtered before it reaches the worklist, but a schema that would have accepted it is one
 * guard short of the fabricated date it exists to prevent.
 */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'expected a real calendar date');
const YearMonth = z.string().regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM');
/**
 * An application number as Source A renders it: `<year>-<sequence>`.
 *
 * The year is one *or* two digits. Source A renders 2000-2009 with a single digit — `0-56`,
 * `1-887`, `2-1117` — and only pads to two from 2010. Requiring two digits rejected the whole
 * decade, which is a tenth of the county's permit history and, being the era right before the
 * 2004 hurricanes, the part most likely to hold a roofing permit still open today.
 *
 * Source B accepts either rendering for the same permit (`0-56` and `00-56` both resolve), so
 * the source's own spelling is kept rather than normalised: it is the join key back to the
 * census row it came from.
 */
export const ApplicationNumber = z.string().regex(/^\d{1,2}-\d{1,8}$/, 'expected Y-NNNNN or YY-NNNNN');

/**
 * Execution input. Every field is optional so `{}` — what a schedule sends — is valid,
 * and the defaults describe a daily incremental rather than a full backfill.
 */
export const HarvestRequest = z
  .object({
    /** Inclusive first month of the Source A sweep. Defaults to the previous month. */
    fromMonth: YearMonth.optional(),
    /** Inclusive last month of the Source A sweep. Defaults to the current month. */
    toMonth: YearMonth.optional(),
    /**
     * Application-type codes to sweep. Defaults to `['ALL']`, which returns every type in
     * one pass; roofing is tagged from the census rather than swept separately.
     */
    applicationTypes: z.array(z.string().min(1).max(8)).min(1).max(120).optional(),
    /** Skip Source B entirely and land the census only. */
    censusOnly: z.boolean().optional(),
    /**
     * How far back Source B refreshes status. Status is only decision-relevant for recent
     * permits, and Source B costs one request per permit at ~2.3 s.
     */
    statusWindowMonths: z.number().int().min(1).max(360).optional(),
    /** Hard cap on permits handed to Source B, so a first run cannot become a 40-hour one. */
    statusPermitLimit: z.number().int().min(1).max(200_000).optional(),
    /**
     * Which end of the Source B worklist survives the limit.
     *
     * `newest` is the operational default. `oldest` exists because the headline question this
     * dataset has to answer is which roofing permits have stayed open for years, and a
     * newest-first worklist truncated at the limit can never reach one.
     */
    statusOrder: z.enum(['newest', 'oldest']).optional(),
    /** Pull status only for applications carrying at least one roofing row. */
    statusRoofingOnly: z.boolean().optional(),
    /**
     * Days an existing observation of a still-open permit stays current.
     *
     * The knob that makes a large sweep runnable in tranches: without it the planner re-selects
     * every open permit it has already seen, and open permits cluster at the head of an
     * oldest-first worklist. Zero forces a full refresh of every non-terminal permit.
     */
    statusRefreshDays: z.number().int().min(0).max(3_650).optional(),
    /**
     * Floor for the Source B window, overriding the one derived from `statusWindowMonths`.
     * Set explicitly when the window wanted is a range rather than a trailing period.
     */
    statusFromMonth: YearMonth.optional(),
    /** Overrides the built-in cost ceiling. Present so a manual run can be capped lower. */
    costCeilingUsd: z.number().positive().max(10_000).optional(),
    /** Ignore the daily 23:30–07:00 Eastern outage. Only for a deliberate operator run. */
    ignoreMaintenanceWindow: z.boolean().optional(),
  })
  .strict();

export type HarvestRequest = z.infer<typeof HarvestRequest>;

/** One unit of Source A work: one application type over one calendar month. */
export const CensusShard = z
  .object({
    runId: z.string().min(1),
    applicationType: z.string().min(1).max(8),
    month: YearMonth,
    periodStart: IsoDate,
    periodEnd: IsoDate,
  })
  .strict()
  .refine((shard) => shard.periodStart <= shard.periodEnd, {
    message: 'periodStart must not be after periodEnd',
  })
  .refine((shard) => shard.periodStart.slice(0, 7) === shard.periodEnd.slice(0, 7), {
    // A server validator rejects any range spanning two months, and the rejection renders
    // an empty grid rather than an error — so a bad range reads as "no permits".
    message: 'both dates must fall in the same calendar month',
  })
  .refine((shard) => Number(shard.month.slice(0, 4)) >= DATA_HORIZON_YEAR, {
    message: `no data exists before ${DATA_HORIZON_YEAR}`,
  });

export type CensusShard = z.infer<typeof CensusShard>;

/** One unit of Source B work: a pointer to a batch of application numbers on S3. */
export const StatusBatch = z
  .object({
    runId: z.string().min(1),
    batchKey: z.string().min(1),
    batchIndex: z.number().int().min(0),
    permitCount: z.number().int().min(1),
  })
  .strict();

export type StatusBatch = z.infer<typeof StatusBatch>;

/**
 * One application on the Source B worklist.
 *
 * Carries the census's verdict on whether the application is roofing rather than leaving
 * Source B to re-derive it. Source B renders a human label (`RES ALTERATIONS, NO CHANGE I`)
 * where Source A renders the application-type code the roofing vocabulary is defined in, so
 * the code is the authoritative signal and it only exists on the census side.
 */
export const ROOFING_MATCH_RULES = ['permit_type', 'application_type', 'description'] as const;

export const RoofingMatchRule = z.enum(ROOFING_MATCH_RULES);

export type RoofingMatchRule = z.infer<typeof RoofingMatchRule>;

export const StatusWorkItem = z
  .object({
    appNo: ApplicationNumber,
    roofing: z.boolean(),
    /**
     * Which roofing vocabularies claimed this application, empty when it was not selected as
     * roofing at all.
     *
     * Carried so a reviewer can see *why* a permit is in a roofing sweep, and so the rules can
     * be judged separately. They disagree substantially — `permit_type` alone accounts for
     * 17,933 of 73,651 roofing applications — and a rule whose precision turns out worse than
     * the others has to be identifiable in the output before it can be dropped from it.
     */
    roofingMatchedBy: z.array(RoofingMatchRule),
    /** Earliest census issue date, so age is known before Source B is asked. */
    censusIssuedOn: IsoDate.nullable(),
    /**
     * The census month shard this application was found earliest in.
     *
     * The age key the sweep actually orders on, because `censusIssuedOn` cannot be trusted for
     * it: 7.88% of census rows carry an `issueDate` outside the month they were harvested in
     * (`2-10436` reads `10/3/30` in the 2003-01 shard), and ordering oldest-first on that field
     * puts 1,859 mis-dated applications from the 1930s to the 1980s at the head of a sweep whose
     * whole purpose is to reach the genuinely oldest permits first.
     */
    censusMonth: z.string().regex(/^\d{4}-\d{2}$/),
  })
  .strict();

export type StatusWorkItem = z.infer<typeof StatusWorkItem>;

/** How a Source A response classified. Two of these look like "no data" and are not. */
export const CENSUS_RESPONSE_STATES = [
  'REJECTED',
  'NO_GRID',
  'EMPTY',
  'SINGLE_PAGE',
  'PAGED',
] as const;

export type CensusResponseState = (typeof CENSUS_RESPONSE_STATES)[number];

/** A deduplicated Source A grid row. */
export interface CensusRow {
  appNo: string;
  description: string;
  parcelId: string;
  propertyAddress: string;
  cityCode: string;
  stateCode: string;
  zipCode: string;
  propertySubdivision: string;
  structureSequence: string;
  permitTypeSequence: string;
  issueDate: string;
  permitType: string;
  ownerName: string;
  contractorName: string;
  valuationAmount: string;
  /** `(appNo, structureSequence, permitTypeSequence)`. `appNo` alone is not unique. */
  rowKey: string;
  /** `issueDate` with the century resolved, or null when unparseable. */
  issuedOn: string | null;
  /** `valuationAmount` as a number, or null when the source left it blank. */
  valuationUsd: number | null;
  /** Whether `description`'s leading code is a roofing application type. */
  roofingRelevant: boolean;
  applicationType: string;
  month: string;
  /** The run that first saw this row. Absent on rows written before the union existed. */
  firstSeenRunId?: string;
  /** The most recent run that saw it, so a row missing from later sweeps is identifiable. */
  lastSeenRunId?: string;
}

/** What one census shard reports back to the state machine. */
export interface CensusShardResult {
  runId: string;
  applicationType: string;
  month: string;
  state: CensusResponseState;
  statedTotal: number | null;
  statedPages: number | null;
  pagesFetched: number;
  rowsSeen: number;
  rowsDeduped: number;
  duplicateRows: number;
  distinctParcels: number;
  roofingRows: number;
  rowsKey: string | null;
  /** The accumulated month key this shard merged into. */
  monthRowsKey: string | null;
  /** Union stats. `rowsCarriedOver` above zero is the pager drift the union exists to absorb. */
  rowsNew: number;
  rowsUpdated: number;
  rowsCarriedOver: number;
  rowsAccumulated: number;
  rawKeys: string[];
  latencyMs: { min: number; median: number; max: number };
  warnings: string[];
}

/** A Source B status record, with open duration assembled from two places. */
export interface PermitStatusRecord {
  runId: string;
  appNo: string;
  parcelId: string | null;
  address: string | null;
  applicationDate: string | null;
  applicationType: string | null;
  owner: string | null;
  tenantName: string | null;
  generalContractor: string | null;
  zoningDescription: string | null;
  valuationUsd: number | null;
  squareFootage: number | null;
  rawStatus: string;
  canonicalStatus: string;
  lifecycle: string;
  terminal: boolean;
  /**
   * When Source B was asked. A status record is a point-in-time observation, not a fact, so
   * reconciling several passes into a current view needs to know which observation is newer.
   */
  harvestedAt: string;
  /** Carried from the census, where the application-type code lives. */
  roofingRelevant: boolean;
  /**
   * Which roofing vocabularies selected this application, in the census's terms.
   *
   * Published so the roofing claim is auditable per permit rather than only in aggregate: a
   * record matched only by `permit_type` is roofing on the strength of a `BPRF` line while its
   * description says something else entirely, and a reviewer is entitled to see that.
   */
  roofingMatchedBy: RoofingMatchRule[];
  /** The census's earliest issue date for this application, for cross-checking. */
  censusIssuedOn: string | null;
  /**
   * Absent for every open permit, and absent for some resolved ones: Source B has no
   * close-date field, so this is the terminal inspection's result date and only exists
   * when that inspection was reached and carried a result.
   */
  closedDate: string | null;
  closedDateSource: 'terminal_inspection' | 'unavailable';
  openDurationDays: number | null;
  openDurationBasis: 'closed' | 'still_open' | 'unknown';
  inspections: InspectionRow[];
  statusRawKey: string;
  inspectionsRawKey: string | null;
}

export interface InspectionRow {
  inspectionType: string;
  scheduledDate: string | null;
  status: string;
  resultDate: string | null;
  permitDescription: string;
}

/** A status value with no mapping. Quarantined and alerted, never bucketed by guess. */
export interface QuarantinedStatus {
  appNo: string;
  rawStatus: string;
  observedAt: string;
  statusRawKey: string;
}

export interface StatusBatchResult {
  runId: string;
  batchIndex: number;
  permitsRequested: number;
  permitsHarvested: number;
  permitsSkippedTerminal: number;
  openPermits: number;
  closedPermits: number;
  withCloseDate: number;
  quarantined: QuarantinedStatus[];
  recordsKey: string | null;
  latencyMs: { min: number; median: number; max: number };
  warnings: string[];
}
