/**
 * Metric-name vocabulary. Every name is PascalCase and is emitted through
 * Powertools Metrics with a `service` dimension — never via raw `putMetricData`.
 *
 * Each metric here must also exist in `observability/metrics.json`, which is the
 * staging manifest for the Lexicon `cloudwatch-metrics.json` registration and the
 * Main Dashboard widget.
 */

/** Metrics every service emits regardless of the domain noun it handles. */
export const UNIVERSAL_METRICS = {
  /** Wall-clock duration of the unit of work, in milliseconds. */
  processingDuration: 'ProcessingDuration',
  /** Predicted USD cost of the unit of work, attributable to the `project_name` tag. */
  costPredicted: 'CostPredicted',
} as const;

/** Domain nouns this pipeline counts. `{Item}Processed` / `{Item}Failed` derive from these. */
export const METRIC_ITEMS = {
  /** A tRPC request served by the API Lambda. */
  request: 'Request',
  /** A PagerDuty trigger handled by the alert notifier. */
  alert: 'Alert',
  /** A parcel moving through an ingestion stage. */
  parcel: 'Parcel',
  /** A permit record harvested for a parcel. */
  permit: 'Permit',
  /** An ingestion run. */
  run: 'Run',
  /** A published artifact (IPFS CID, manifest, query table). */
  artifact: 'Artifact',
} as const;

export type MetricItem = (typeof METRIC_ITEMS)[keyof typeof METRIC_ITEMS];

export function processedMetric<T extends MetricItem>(item: T): `${T}Processed` {
  return `${item}Processed`;
}

export function failedMetric<T extends MetricItem>(item: T): `${T}Failed` {
  return `${item}Failed`;
}

/**
 * AWS Lambda on-demand pricing for x86 in `us-east-2`.
 * @see https://aws.amazon.com/lambda/pricing/
 */
const LAMBDA_GB_SECOND_USD = 0.0000166667;
const LAMBDA_REQUEST_USD = 0.0000002;

/**
 * Predicted USD cost of a single Lambda invocation, used as the value of the
 * `CostPredicted` metric. This is a forecast derived from billed duration and
 * configured memory — it is not a billing figure and is never reconciled here.
 */
export function predictInvocationCostUsd(durationMs: number, memoryMb: number): number {
  const gbSeconds = (memoryMb / 1024) * (durationMs / 1000);
  return gbSeconds * LAMBDA_GB_SECOND_USD + LAMBDA_REQUEST_USD;
}
