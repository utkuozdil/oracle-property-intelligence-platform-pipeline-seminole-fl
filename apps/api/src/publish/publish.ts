import { GetObjectCommand, ListObjectsV2Command, S3Client, type _Object } from '@aws-sdk/client-s3';
import { AWS_REGION, COUNTY, PUBLISH_POINTER_KEY } from '@oracle-seminole/shared';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { carBytes, packDirectory, packRootDirectory, type RootChild } from './car';
import {
  carKey,
  DATASETS,
  FILEBASE_STORAGE_QUOTA_BYTES,
  IPNS_LABEL,
  VERIFY_GATEWAY,
  type DatasetName,
} from './config';
import {
  buildGeoIndex,
  buildOpenData,
  buildQueryTable,
  type DatasetProvenance,
  type DatasetSummary,
} from './datasets';
import { getIpnsName, importCar, pointIpnsName } from './filebase';
import { checkParquetMagic, checkPath, ipfsUrl, ipnsUrl, waitForRoot, warm } from './gateway';
import {
  readIpfsPointer,
  writeIpfsPointer,
  type IpfsPublicationRecord,
  type PublishedDataset,
} from './pointer';

/**
 * Publishes the current snapshot to Elephant IPFS through Filebase, then proves it
 * resolves on a gateway nobody in this account controls.
 *
 * The whole step is idempotent on content, not on time. Dataset artifacts are built
 * deterministically, so the CAR roots computed locally are a content hash of the
 * snapshot; if they match what the last publish recorded and the IPNS name already points
 * at that root, nothing is uploaded. That matters more than usual here — the free plan
 * allows 5 GB of storage and 5 GB of monthly egress, so a nightly re-upload of unchanged
 * data would exhaust the account inside a week.
 *
 * Ordering is the correctness argument, and it is the same one the S3 publish step makes.
 * Dataset CARs upload first, then the root CAR that references them, then the IPNS
 * re-point, then verification, and the publication record is written last. A crash at any
 * point leaves pinned-but-unreferenced blocks — wasted quota, not a name pointing at a
 * DAG that is missing children.
 */

export interface PublishIpfsOptions {
  /** Scratch directory for the downloaded snapshot, built datasets and CARs. */
  workDir: string;
  /** Upload even when the computed CIDs match the recorded ones. */
  force?: boolean;
  onProgress?: (message: string) => void;
}

interface PublishPointer {
  runId: string;
  county: string;
  snapshotPrefix: string;
  parcelCount: number;
  objectCount: number;
  publishedAt: string;
}

interface ChangeSetProvenance {
  sourceFingerprint: string | null;
  snapshotYear: number | null;
}

class PublishError extends Error {
  override readonly name = 'PublishError';
}

export interface PublishPlan {
  s3: S3Client;
  runId: string;
  provenance: DatasetProvenance;
  summaries: Record<DatasetName, DatasetSummary>;
  packed: PackedDatasets;
  previous: IpfsPublicationRecord | null;
  /** What the IPNS name resolves to today, or `null` before the first publish. */
  ipnsCid: string | null;
}

/**
 * Everything up to, but not including, the first byte of upload.
 *
 * Separated out so `just publish-ipfs --dry-run` can report exactly which datasets a
 * publish would move and what it would cost before committing any of a 5 GB allowance.
 * That is only meaningful because the build is deterministic: the CIDs a dry run prints
 * are the CIDs a real publish will produce.
 */
export async function planPublish(
  bucket: string,
  options: PublishIpfsOptions,
): Promise<PublishPlan> {
  const report = options.onProgress ?? (() => {});
  const s3 = new S3Client({ region: AWS_REGION });

  const pointer = await readPublishPointer(s3, bucket);
  report(
    `snapshot ${pointer.runId}: ${pointer.parcelCount} parcels, ${pointer.objectCount} objects`,
  );

  const snapshotDir = join(options.workDir, 'snapshot');
  const downloaded = await downloadSnapshot(s3, bucket, pointer, snapshotDir);
  report(
    `snapshot local: ${downloaded.objects} objects, ${mib(downloaded.bytes)} (${downloaded.action})`,
  );

  const provenance: DatasetProvenance = {
    runId: pointer.runId,
    county: pointer.county || COUNTY,
    // Fixed to the snapshot's own publish time, not to now. A timestamp of "now" inside
    // every artifact would change the CIDs on every run and defeat the idempotency the
    // quota depends on.
    publishedAt: pointer.publishedAt,
    snapshotPrefix: pointer.snapshotPrefix,
    parcelCount: pointer.parcelCount,
    ...(await readChangeSetProvenance(s3, bucket, pointer.runId)),
  };

  const summaries = await buildDatasets(snapshotDir, options.workDir, provenance, report);
  const packed = await packDatasets(options.workDir, summaries, report);

  return {
    s3,
    runId: pointer.runId,
    provenance,
    summaries,
    packed,
    previous: await readIpfsPointer(s3, bucket),
    ipnsCid: await currentIpnsCid(),
  };
}

export async function publishToIpfs(
  bucket: string,
  options: PublishIpfsOptions,
): Promise<IpfsPublicationRecord> {
  const report = options.onProgress ?? (() => {});
  const { s3, runId, provenance, summaries, packed, previous, ipnsCid } = await planPublish(
    bucket,
    options,
  );

  const rootUnchanged = previous?.rootCid === packed.rootCid;
  const alreadyPointed = ipnsCid === packed.rootCid;

  if (rootUnchanged && alreadyPointed && options.force !== true) {
    report(`unchanged: root ${packed.rootCid} already published and IPNS already points at it`);
  } else {
    await uploadChanged(packed, previous, options.force === true, report);
  }

  const ipns = await pointIpnsName(IPNS_LABEL, packed.rootCid);
  report(
    `ipns ${ipns.label} -> ${packed.rootCid} (sequence ${ipns.sequence}), name ${ipns.network_key}`,
  );

  const datasets = buildDatasetRecords(packed, summaries, previous, ipns.network_key);
  const verification = await verify(packed.rootCid, ipns.network_key, datasets, report);

  const totals = Object.values(datasets).reduce(
    (accumulator, dataset) => ({
      bytes: accumulator.bytes + dataset.bytes,
      files: accumulator.files + dataset.files,
    }),
    { bytes: 0, files: 0 },
  );

  const record: IpfsPublicationRecord = {
    version: 1,
    runId,
    county: provenance.county,
    provider: 'filebase',
    publishedAt: new Date().toISOString(),
    ipns: {
      label: ipns.label,
      name: ipns.network_key,
      sequence: ipns.sequence,
      url: ipnsUrl(ipns.network_key),
    },
    rootCid: packed.rootCid,
    rootUrl: `${VERIFY_GATEWAY}/ipfs/${packed.rootCid}`,
    datasets,
    totals: {
      ...totals,
      quotaBytes: FILEBASE_STORAGE_QUOTA_BYTES,
      quotaUsedFraction: Number((totals.bytes / FILEBASE_STORAGE_QUOTA_BYTES).toFixed(4)),
    },
    verification,
    unchanged: rootUnchanged && alreadyPointed,
  };

  const written = await writeIpfsPointer(s3, bucket, record);
  report(`recorded s3://${bucket}/${written.recordKey} and s3://${bucket}/${written.pointerKey}`);

  return record;
}

/** The snapshot pointer is the only input: publish what is currently published to S3. */
async function readPublishPointer(s3: S3Client, bucket: string): Promise<PublishPointer> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: PUBLISH_POINTER_KEY }),
  );
  const body = await response.Body?.transformToString();
  if (!body) {
    throw new PublishError(
      `${PUBLISH_POINTER_KEY} is empty — nothing has been published to S3 yet`,
    );
  }
  return JSON.parse(body) as PublishPointer;
}

/**
 * Source provenance for the per-property documents.
 *
 * Absent is a normal state — the change set is run-scoped and an older run may predate
 * it — so a missing object degrades the documents' provenance block rather than failing
 * a publish that is otherwise correct.
 */
async function readChangeSetProvenance(
  s3: S3Client,
  bucket: string,
  runId: string,
): Promise<ChangeSetProvenance> {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: `manifests/${runId}/change_set.json` }),
    );
    const body = await response.Body?.transformToString();
    const parsed = JSON.parse(body ?? '{}') as {
      source?: { fingerprint?: string };
      snapshotYear?: number;
    };
    return {
      sourceFingerprint: parsed.source?.fingerprint ?? null,
      snapshotYear: parsed.snapshotYear ?? null,
    };
  } catch {
    return { sourceFingerprint: null, snapshotYear: null };
  }
}

async function listAll(s3: S3Client, bucket: string, prefix: string): Promise<_Object[]> {
  const objects: _Object[] = [];
  let token: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    objects.push(...(page.Contents ?? []));
    token = page.NextContinuationToken;
  } while (token);

  return objects;
}

/**
 * Mirror the published snapshot locally, skipping objects already present at the right
 * size. Re-running the publish after a failure part-way through should not re-pull 40 MB.
 */
async function downloadSnapshot(
  s3: S3Client,
  bucket: string,
  pointer: PublishPointer,
  snapshotDir: string,
): Promise<{ objects: number; bytes: number; action: string }> {
  const prefix = pointer.snapshotPrefix.replace(`s3://${bucket}/`, '');
  const objects = (await listAll(s3, bucket, prefix)).filter((object) =>
    object.Key?.endsWith('.parquet'),
  );

  if (objects.length === 0) {
    throw new PublishError(`no Parquet under s3://${bucket}/${prefix}`);
  }

  let fetched = 0;
  let bytes = 0;

  for (const object of objects) {
    const key = object.Key as string;
    const target = join(snapshotDir, key.slice(prefix.length));
    bytes += object.Size ?? 0;

    if (existsSync(target) && statSync(target).size === object.Size) {
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(response.Body as Readable, createWriteStream(target));
    fetched += 1;
  }

  return {
    objects: objects.length,
    bytes,
    action: fetched === 0 ? 'cached' : `${fetched} downloaded`,
  };
}

async function buildDatasets(
  snapshotDir: string,
  workDir: string,
  provenance: DatasetProvenance,
  report: (message: string) => void,
): Promise<Record<DatasetName, DatasetSummary>> {
  const dir = (dataset: DatasetName) => join(workDir, 'build', dataset);

  const queryTable = buildQueryTable(snapshotDir, dir('query-table'), provenance);
  report(`built query-table: ${queryTable.coverage}, ${mib(queryTable.bytes)}`);

  const geoIndex = buildGeoIndex(snapshotDir, dir('geo-index'), provenance);
  report(`built geo-index: ${geoIndex.coverage}, ${mib(geoIndex.bytes)}`);

  const openData = await buildOpenData(snapshotDir, dir('open-data'), provenance);
  report(`built open-data: ${openData.coverage}, ${mib(openData.bytes)}`);

  return { 'query-table': queryTable, 'geo-index': geoIndex, 'open-data': openData };
}

interface PackedDatasets {
  datasets: Record<DatasetName, { cid: string; carPath: string; carBytes: number }>;
  rootCid: string;
  rootCarPath: string;
  rootCarBytes: number;
}

async function packDatasets(
  workDir: string,
  summaries: Record<DatasetName, DatasetSummary>,
  report: (message: string) => void,
): Promise<PackedDatasets> {
  const carDir = join(workDir, 'car');
  mkdirSync(carDir, { recursive: true });

  const datasets = {} as PackedDatasets['datasets'];
  const children: RootChild[] = [];

  for (const dataset of DATASETS) {
    const carPath = join(carDir, `${dataset}.car`);
    const cid = packDirectory(join(workDir, 'build', dataset), carPath);
    datasets[dataset] = { cid, carPath, carBytes: carBytes(carPath) };
    children.push({ name: dataset, cid, tsize: summaries[dataset].bytes });
    report(`packed ${dataset}: ${cid} (car ${mib(datasets[dataset].carBytes)})`);
  }

  const rootCarPath = join(carDir, 'root.car');
  const rootCid = await packRootDirectory(children, rootCarPath);
  report(`packed root: ${rootCid} (car ${carBytes(rootCarPath)} bytes)`);

  return { datasets, rootCid, rootCarPath, rootCarBytes: carBytes(rootCarPath) };
}

/**
 * Read the CID the IPNS name currently resolves to, without going near a gateway.
 *
 * Absence of the name is the first-publish case, not an error.
 */
async function currentIpnsCid(): Promise<string | null> {
  const record = await getIpnsName(IPNS_LABEL);
  return record?.cid ?? null;
}

/**
 * Upload only the CARs whose content changed.
 *
 * A CAR may reference blocks it does not carry, so the county root is a few hundred bytes
 * of directory node. A run where only the query table moved therefore spends 22 MB of
 * quota, not 100 MB — which is what makes nightly re-publication affordable at all on a
 * 5 GB plan.
 */
async function uploadChanged(
  packed: PackedDatasets,
  previous: IpfsPublicationRecord | null,
  force: boolean,
  report: (message: string) => void,
): Promise<void> {
  for (const dataset of DATASETS) {
    const local = packed.datasets[dataset];
    if (!force && previous?.datasets[dataset]?.cid === local.cid) {
      report(`skipped ${dataset}: unchanged at ${local.cid}`);
      continue;
    }

    const reported = await importCar(carKey(dataset), local.carPath);
    if (reported !== local.cid) {
      throw new PublishError(
        `${dataset}: Filebase pinned ${reported} but the local CAR root is ${local.cid} — ` +
          'the upload did not preserve the DAG',
      );
    }
    report(`uploaded ${dataset}: ${mib(local.carBytes)} -> ${reported}`);
  }

  const reportedRoot = await importCar(carKey('root'), packed.rootCarPath);
  if (reportedRoot !== packed.rootCid) {
    throw new PublishError(
      `root: Filebase pinned ${reportedRoot} but the local CAR root is ${packed.rootCid}`,
    );
  }
  report(`uploaded root: ${packed.rootCarBytes} bytes -> ${reportedRoot}`);
}

function buildDatasetRecords(
  packed: PackedDatasets,
  summaries: Record<DatasetName, DatasetSummary>,
  previous: IpfsPublicationRecord | null,
  networkKey: string,
): Record<DatasetName, PublishedDataset> {
  const records = {} as Record<DatasetName, PublishedDataset>;

  for (const dataset of DATASETS) {
    const local = packed.datasets[dataset];
    const summary = summaries[dataset];
    records[dataset] = {
      cid: local.cid,
      entryPath: summary.entryPath,
      url: ipnsUrl(networkKey, summary.entryPath),
      // The entry path is `<dataset>/<file>`; addressed by the dataset's own CID the
      // dataset segment falls away, because that CID *is* the dataset directory.
      immutableUrl: ipfsUrl(local.cid, summary.entryPath.split('/').slice(1).join('/')),
      bytes: summary.bytes,
      files: summary.files,
      coverage: summary.coverage,
      carKey: carKey(dataset),
      carBytes: local.carBytes,
      uploaded: previous?.datasets[dataset]?.cid !== local.cid,
      notes: summary.notes,
    };
  }

  return records;
}

/**
 * Prove the publication resolves, through a gateway this account does not control.
 *
 * The first check is the one that matters: `x-ipfs-roots` on an `/ipns/` fetch must name
 * the root just published. That single header distinguishes "content is missing" from
 * "the name is still pointing at the previous run", which are the two silent failures a
 * publish step can have, and which look identical from a 200 alone.
 */
async function verify(
  rootCid: string,
  networkKey: string,
  datasets: Record<DatasetName, PublishedDataset>,
  report: (message: string) => void,
): Promise<IpfsPublicationRecord['verification']> {
  const anchor = await waitForRoot(ipnsUrl(networkKey, 'query-table/manifest.json'), rootCid);
  report(`verified ipns -> ${anchor.resolvedRoot} in ${anchor.elapsedMs} ms`);

  const checks = [anchor];
  for (const dataset of DATASETS) {
    if (datasets[dataset].entryPath.endsWith('.parquet')) continue;
    const check = await checkPath(datasets[dataset].url);
    checks.push(check);
    report(`verified ${datasets[dataset].entryPath}: ${check.status} in ${check.elapsedMs} ms`);
  }

  const parquetUrl = datasets['query-table'].url;
  const parquetRange = await checkParquetMagic(parquetUrl);
  if (parquetRange.status !== 206 || parquetRange.magic !== 'PAR1') {
    throw new PublishError(
      `range read of ${parquetUrl} returned ${parquetRange.status} / "${parquetRange.magic}", ` +
        'expected 206 / "PAR1" — DuckDB cannot query this over HTTP',
    );
  }
  report(`verified parquet range read: 206 PAR1`);

  const warmed = await warm(parquetUrl);
  report(`warmed query table: ${mib(warmed.bytes)} in ${warmed.elapsedMs} ms`);

  const failed = checks.filter((check) => check.status !== 200);
  if (failed.length > 0) {
    throw new PublishError(
      `${failed.length} published paths did not resolve, first: ${failed[0]?.url} -> ${failed[0]?.status}`,
    );
  }

  return {
    gateway: VERIFY_GATEWAY,
    checkedAt: new Date().toISOString(),
    checks,
    parquetRange,
  };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}
