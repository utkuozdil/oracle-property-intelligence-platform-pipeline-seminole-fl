/**
 * Filebase / Elephant IPFS publication settings.
 *
 * Every value here was confirmed against a live account. Two of them contradict the
 * documentation you will find by searching, and both contradictions cost real time:
 * the IPNS management API is `/v1/names` (`/v1/ipns` does not exist), and the signing
 * region is `us-east-1` regardless of where the rest of this deployment lives.
 *
 * See `docs/filebase-publish-mechanics.md` for the measurements behind these choices.
 */

/** S3-compatible endpoint. Path-style addressing; bucket names are account-global. */
export const FILEBASE_S3_ENDPOINT = 'https://s3.filebase.com';

/**
 * Signing region, not a deployment region.
 *
 * Filebase signs every request as `us-east-1` no matter which of its storage regions
 * the bucket lives in. Passing our own `us-east-2` produces a signature mismatch, which
 * surfaces as an opaque `SignatureDoesNotMatch` rather than as a region error.
 */
export const FILEBASE_SIGNING_REGION = 'us-east-1';

/** IPNS name management. `/v1/ipns` is a plausible-looking 404. */
export const FILEBASE_NAMES_API = 'https://api.filebase.io/v1/names';

/**
 * The free plan allows exactly one bucket and exactly one IPNS name — the second create
 * of either returns `409`. The whole county therefore publishes as one root DAG with
 * per-dataset subdirectories, addressed as `/ipns/<name>/<dataset>/<file>`.
 */
export const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET ?? 'oracle-open-data-seminole';
export const IPNS_LABEL = process.env.FILEBASE_IPNS_LABEL ?? 'oracle-seminole';

/**
 * Verification gateway.
 *
 * Deliberately not `ipfs.filebase.io`. That gateway caches per path with `max-age=300`
 * and was measured serving three different generations of one IPNS name at the same
 * time, 296 s and 378 s behind the re-point. A post-publish check against it reads the
 * *previous* run and can pass or fail for reasons unrelated to this run's correctness.
 * `ipfs.io` reflected a re-point in under 5 s on every sample.
 */
export const VERIFY_GATEWAY = 'https://ipfs.io';

/**
 * Datasets, in the order `dag-pb` requires.
 *
 * Directory links must be sorted by name or the root block hashes differently from the
 * canonical encoding of the same tree, and the CID we compute locally stops matching the
 * one Filebase reports back — which is our only integrity check on the upload.
 */
export const DATASETS = ['geo-index', 'open-data', 'query-table'] as const;

export type DatasetName = (typeof DATASETS)[number];

/** Where the staging CARs land in the Filebase bucket. Not the served surface. */
export function carKey(dataset: DatasetName | 'root'): string {
  return `layout/${dataset}.car`;
}

/**
 * Byte budget for the per-property consolidation index.
 *
 * The index is a second encoding of data already published whole in `query-table/`, so
 * bounding it costs coverage of the *index*, not of the dataset. It is bounded for two
 * reasons: the free plan's 5 GB monthly egress does not survive a crawl of 181,218
 * documents, and the largest CAR import actually verified against Filebase was 118 MB,
 * so a budget in this range keeps the publish on a proven path instead of betting the run
 * on an untested one.
 *
 * A budget rather than a shard count because the constraint really is bytes — shard sizes
 * vary by more than 10x across the county, so "twelve shards" means anything between
 * 30 MB and 250 MB.
 *
 * Measured at 1,617 bytes of JSON per property, the *full* index is ~293 MB — not the
 * 3.77 GB an earlier extrapolation from a richer reference county suggested. Publishing
 * it whole would fit the 5 GB plan; raising this value is the only change required.
 */
export const OPEN_DATA_MAX_BYTES = Number(process.env.OPEN_DATA_MAX_BYTES ?? 100 * 1024 ** 2);

/** Free-plan storage ceiling, used to report headroom rather than to enforce anything. */
export const FILEBASE_STORAGE_QUOTA_BYTES = 5 * 1024 ** 3;

export interface FilebaseCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

class MissingCredentialsError extends Error {
  override readonly name = 'MissingCredentialsError';
}

/**
 * Read the Filebase keys from the environment.
 *
 * They live in `~/.filebase/credentials` (mode 600) and are sourced by the `just`
 * recipe. They are never read from a file here and never logged: the IPNS bearer token
 * is a base64 of the pair, so anything that prints one prints both.
 */
export function filebaseCredentials(): FilebaseCredentials {
  const accessKeyId = process.env.FILEBASE_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.FILEBASE_SECRET_ACCESS_KEY ?? '';

  if (!accessKeyId || !secretAccessKey) {
    throw new MissingCredentialsError(
      'FILEBASE_ACCESS_KEY_ID and FILEBASE_SECRET_ACCESS_KEY must be set — ' +
        'run `set -a; . ~/.filebase/credentials; set +a` first, or use `just publish-ipfs`',
    );
  }

  return { accessKeyId, secretAccessKey };
}

/**
 * Bearer credential for the names API: base64 of the S3 key pair.
 *
 * There is no separate IPNS token to provision, which is convenient and also means a
 * leaked bearer header is a leaked S3 key pair.
 */
export function ipnsAuthorization(credentials: FilebaseCredentials): string {
  const pair = `${credentials.accessKeyId}:${credentials.secretAccessKey}`;
  return `Bearer ${Buffer.from(pair, 'utf8').toString('base64')}`;
}
