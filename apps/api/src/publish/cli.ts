import { mkdirSync } from 'node:fs';
import { recordArtifactCids } from './artifacts';
import { DATASETS } from './config';
import { planPublish, publishToIpfs } from './publish';

/**
 * `just publish-ipfs` — publish the current S3 snapshot to Elephant IPFS.
 *
 * Deliberately a command run from the pipeline runner rather than a deployed Lambda.
 * The milestone's constraint is that Oracle carries no standing infrastructure cost, and
 * an IPFS publish needs the Filebase key pair; putting it in a Lambda means a Secrets
 * Manager secret, a KMS key and an execution role that exist and bill every month for a
 * step that runs once per refresh. The publish is also the one step whose duration is
 * bounded by the runner's uplink, not by anything AWS charges for.
 *
 * Credentials come from the environment and are never read from disk here — the recipe
 * sources `~/.filebase/credentials` before invoking this.
 */

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const bucket = process.env.DATA_BUCKET ?? '';
  if (!bucket) {
    throw new Error('DATA_BUCKET is not set — `just publish-ipfs` resolves it from SSM');
  }

  const workDir = process.env.PUBLISH_WORK_DIR ?? '.publish-work';
  mkdirSync(workDir, { recursive: true });

  if (process.argv.includes('--dry-run')) {
    await dryRun(bucket, workDir);
    return;
  }

  const record = await publishToIpfs(bucket, {
    workDir,
    force: process.env.PUBLISH_FORCE === 'true',
    onProgress: (message) => out(`  ${message}`),
  });

  const tableName = process.env.TABLE_NAME ?? '';
  if (tableName) {
    const items = await recordArtifactCids(tableName, record);
    out(`  recorded ${items} artifact-CID items under CID#${record.runId}`);
  } else {
    out('  TABLE_NAME not set — skipped the DynamoDB artifact-CID items');
  }

  out('');
  out(
    `IPNS name   ${record.ipns.name}  (label ${record.ipns.label}, sequence ${record.ipns.sequence})`,
  );
  out(`Root CID    ${record.rootCid}`);
  out(`Gateway     ${record.ipns.url}`);
  out('');
  for (const [dataset, published] of Object.entries(record.datasets)) {
    out(`${dataset.padEnd(12)} ${published.cid}`);
    out(`${''.padEnd(12)} ${published.url}`);
    out(
      `${''.padEnd(12)} ${mib(published.bytes)}, ${published.files} files, ${published.coverage}`,
    );
  }
  out('');
  out(
    `Total ${mib(record.totals.bytes)} of ${mib(record.totals.quotaBytes)} free-plan storage ` +
      `(${(record.totals.quotaUsedFraction * 100).toFixed(1)}%)`,
  );
  out(record.unchanged ? 'Content unchanged — no upload quota spent.' : 'Published new content.');
}

/** Build, pack, compare, upload nothing. Prints what a real publish would spend. */
async function dryRun(bucket: string, workDir: string): Promise<void> {
  const plan = await planPublish(bucket, { workDir, onProgress: (message) => out(`  ${message}`) });

  out('');
  out(`Root CID    ${plan.packed.rootCid}`);
  out(`Recorded    ${plan.previous?.rootCid ?? '(none — first publish)'}`);
  out(`IPNS points ${plan.ipnsCid ?? '(name does not exist yet)'}`);
  out('');

  let wouldUpload = 0;
  for (const dataset of DATASETS) {
    const local = plan.packed.datasets[dataset];
    const changed = plan.previous?.datasets[dataset]?.cid !== local.cid;
    if (changed) wouldUpload += local.carBytes;
    out(
      `${dataset.padEnd(12)} ${local.cid}  ${mib(local.carBytes)} CAR  ` +
        `${changed ? 'WOULD UPLOAD' : 'unchanged'}`,
    );
  }

  out('');
  out(`Would upload ${mib(wouldUpload + plan.packed.rootCarBytes)}. Nothing was uploaded.`);
}

function mib(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
