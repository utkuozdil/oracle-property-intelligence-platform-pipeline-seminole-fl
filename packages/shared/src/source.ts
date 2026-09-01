/**
 * The Seminole County CAMA source contract, and the cost model for transforming it.
 *
 * Mirrored by `oracle_pipeline/constants.py` on the Glue side. The values here were
 * measured against the live source, not read from a data dictionary.
 */

/** Nightly CAMA extract: nine CSVs, rebuilt around 04:00 local. */
export const SOURCE_URL = 'https://files.scpafl.org/data/cama/SeminoleCounty.zip';

/** Logical name of the source in the DynamoDB ledger (`SOURCE#<name>`). */
export const SOURCE_NAME = 'seminole-cama';

/**
 * The host **stalls** rather than returning 403 when the request carries no
 * browser-like `User-Agent`. A stall is far worse than a rejection: the socket stays
 * open and the Lambda burns its whole timeout, so this header is load-bearing.
 */
export const SOURCE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Compressed size observed on 2026-08-31. Used only to sanity-check a `HEAD`. */
export const OBSERVED_ARCHIVE_BYTES = 94_847_956;

/** Uncompressed total across the nine CSVs. */
export const OBSERVED_UNCOMPRESSED_BYTES = 641_329_104;

/** Parcels in the extract. The transform asserts its own output against this order of magnitude. */
export const OBSERVED_PARCEL_COUNT = 181_217;

/**
 * `HEAD` responses whose `Content-Length` falls outside this band are treated as a
 * source-side accident rather than growth. ±60% around the observed size: the archive
 * grows by low single-digit percent a year.
 */
export const ARCHIVE_BYTES_MIN = Math.round(OBSERVED_ARCHIVE_BYTES * 0.4);
export const ARCHIVE_BYTES_MAX = Math.round(OBSERVED_ARCHIVE_BYTES * 1.6);

/**
 * AWS Glue 5.0 ETL, `us-east-2`, per DPU-hour.
 * @see https://aws.amazon.com/glue/pricing/
 */
export const GLUE_DPU_HOUR_USD = 0.44;

/** Workers configured on the job, including the driver. Mirrors `NUMBER_OF_WORKERS`. */
export const GLUE_WORKERS = 10;

/** Glue bills per second with a one-minute minimum. */
export const GLUE_MINIMUM_BILLED_MINUTES = 1;

/**
 * Minutes of Glue runtime expected per uncompressed gigabyte.
 *
 * Calibrated against the first real run: 0.597 GiB uncompressed finished in 2.77 minutes
 * on 10 G.1X workers, or 4.63 min/GB. This is set to roughly twice that, so an ordinary
 * night predicts comfortably under the ceiling while a genuinely slower run — more
 * Python-UDF pressure, a colder cluster, a fatter `AllSales` — still lands inside the
 * estimate rather than blowing through it.
 *
 * Erring high is the correct direction for a gate whose purpose is to refuse surprises,
 * but the pre-run guess of 25 was 5.4x the measured rate, which made every estimate
 * meaningless as a number and left the ceiling doing no real work. A model that is
 * always wrong by 5x is a model nobody reads.
 */
export const GLUE_MINUTES_PER_UNCOMPRESSED_GB = 10;

/** Measured on the first full run, retained so the calibration above stays auditable. */
export const OBSERVED_GLUE_MINUTES_PER_GB = 4.63;

/**
 * S3 request cost for one run: the nine multipart-uploaded CSVs, the Parquet partition
 * writes, and the reads back. Rounded up generously; it is cents against the DPU cost
 * and exists so the estimate is not silently missing a line item.
 */
export const S3_REQUEST_USD_PER_RUN = 0.02;

export interface TransformCostEstimate {
  archiveBytes: number;
  estimatedUncompressedBytes: number;
  estimatedGlueMinutes: number;
  estimatedDpuHours: number;
  glueCostUsd: number;
  s3CostUsd: number;
  totalCostUsd: number;
}

/**
 * Predict the USD cost of transforming an archive of `archiveBytes`.
 *
 * Scales the observed compression ratio (6.76x) rather than assuming a fixed
 * uncompressed size, so an archive that doubles is costed as an archive that doubled.
 */
export function predictTransformCostUsd(archiveBytes: number): TransformCostEstimate {
  const compressionRatio = OBSERVED_UNCOMPRESSED_BYTES / OBSERVED_ARCHIVE_BYTES;
  const estimatedUncompressedBytes = archiveBytes * compressionRatio;
  const uncompressedGb = estimatedUncompressedBytes / 1_024 ** 3;

  const estimatedGlueMinutes = Math.max(
    GLUE_MINIMUM_BILLED_MINUTES,
    uncompressedGb * GLUE_MINUTES_PER_UNCOMPRESSED_GB,
  );
  const estimatedDpuHours = (estimatedGlueMinutes / 60) * GLUE_WORKERS;
  const glueCostUsd = estimatedDpuHours * GLUE_DPU_HOUR_USD;

  return {
    archiveBytes,
    estimatedUncompressedBytes,
    estimatedGlueMinutes,
    estimatedDpuHours,
    glueCostUsd,
    s3CostUsd: S3_REQUEST_USD_PER_RUN,
    totalCostUsd: glueCostUsd + S3_REQUEST_USD_PER_RUN,
  };
}

/**
 * Cost ceiling above which the workflow pauses for human approval.
 *
 * With the calibrated model a full nightly county refresh predicts at about $0.46 and
 * actually bills about $0.21, so $2.00 stops a run whose input has grown roughly
 * four-fold while leaving ordinary night-to-night variance alone. Deliberately a fixed
 * contract rather than a tunable: the number that matters is the one nobody can quietly
 * raise on the night it would have fired.
 */
export const COST_CEILING_USD = 2.0;
