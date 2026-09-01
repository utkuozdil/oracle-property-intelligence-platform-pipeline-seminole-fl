import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DATA_PREFIXES, type DataPrefix } from '@oracle-seminole/shared';
import { tracer } from '../observability';

export const DATA_BUCKET_NAME = process.env.DATA_BUCKET_NAME ?? '';

const s3 = tracer.captureAWSv3Client(new S3Client({}));

export interface PrefixSummary {
  prefix: DataPrefix;
  /** Object count in the first page. Phase 0 only needs to prove the prefix is readable. */
  objectCount: number;
}

/**
 * Confirms the four data-lake prefixes are present and readable with the Lambda's own
 * role. This is the S3 half of the readiness probe.
 */
export async function summarisePrefixes(): Promise<PrefixSummary[]> {
  return Promise.all(
    Object.values(DATA_PREFIXES).map(async (prefix) => {
      const response = await s3.send(
        new ListObjectsV2Command({ Bucket: DATA_BUCKET_NAME, Prefix: prefix, MaxKeys: 100 }),
      );
      return { prefix, objectCount: response.KeyCount ?? 0 };
    }),
  );
}
