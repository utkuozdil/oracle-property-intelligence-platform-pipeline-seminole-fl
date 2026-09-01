/**
 * Publish permit history into `publish/`, beside the parcels.
 *
 * Run from the pipeline runner rather than as a deployed Lambda, for the same reason the IPFS
 * publish is: the build needs DuckDB and a few hundred megabytes of scratch, and the census sweep
 * it reads is expected to grow for hours, so this is re-run by an operator watching coverage
 * rather than triggered once per nightly refresh. Nothing here bills when idle.
 *
 *     DATA_BUCKET=$(just _data-bucket) \
 *     PERMIT_PUBLISH_WORK_DIR="$PWD/.publish-work/permits" \
 *       pnpm --filter @oracle-seminole/api exec tsx src/publish/permit-cli.ts [--dry-run]
 *
 * There is deliberately no `just` recipe yet — the justfile is shared and outside this tier's
 * ownership. `docs/permit-publication.md` carries the recipe to add.
 *
 * Re-running is the normal case and is cheap. The run id is a fingerprint of the input objects,
 * so a re-run against an unchanged bucket rebuilds locally, recognises the generation is already
 * published, and uploads nothing. `PUBLISH_FORCE=true` overrides that.
 */
import { mkdirSync } from 'node:fs';
import { planPermitPublish, publishPermits } from './permit-publish';

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const bucket = process.env.DATA_BUCKET ?? '';
  if (!bucket) {
    throw new Error('DATA_BUCKET is not set — resolve it with `just _data-bucket`');
  }

  const workDir = process.env.PERMIT_PUBLISH_WORK_DIR ?? '.publish-work/permits';
  mkdirSync(workDir, { recursive: true });

  const options = {
    workDir,
    force: process.env.PUBLISH_FORCE === 'true',
    onProgress: (message: string) => out(`  ${message}`),
  };

  const record = process.argv.includes('--dry-run')
    ? (await planPermitPublish(bucket, options)).record
    : await publishPermits(bucket, options);

  const { census, status, bbb } = record.coverage;

  out('');
  out(`Run          ${record.runId}`);
  out(`Prefix       s3://${bucket}/${record.prefix}`);
  out(`Reference    ${record.referenceDate}  (every open_years is measured to this instant)`);
  out('');
  for (const artifact of [
    record.files.permits,
    record.files.parcelIndex,
    record.files.contractors,
  ]) {
    out(
      `${artifact.file.padEnd(22)} ${artifact.rows.toLocaleString('en-US').padStart(9)} rows  ` +
        `${mib(artifact.bytes).padStart(10)}`,
    );
  }
  out(`${'total'.padEnd(22)} ${''.padStart(9)}       ${mib(record.totals.bytes).padStart(10)}`);
  out('');
  out(
    `History      ${census.firstMonth} to ${census.lastMonth}, ${census.months} months` +
      (census.contiguous ? ', contiguous' : `, ${census.missingMonths.length} missing`),
  );
  out(
    `Status       ${status.applicationsWithStatus} of ${status.applicationsTotal} applications ` +
      `(${(status.fraction * 100).toFixed(3)}%) — every other permit is "unknown", not closed`,
  );
  out(
    `BBB          ${bbb.contractorsRated} rated of ${bbb.contractorsSearched} searched, ` +
      `against ${record.counts.contractorNames.toLocaleString('en-US')} contractors in the census`,
  );
  out('');
  out(
    `Parcels with a permit             ${record.counts.publishedParcels.toLocaleString('en-US')} of ` +
      `${record.parcelSnapshot.parcelCount.toLocaleString('en-US')}`,
  );
  out(
    `Parcels with an open permit >3y   ${record.counts.parcelsWithOpenPermitOverThreeYears}` +
      ` (roofing: ${record.counts.parcelsWithOpenRoofingPermitOverThreeYears})`,
  );
  out('');
  out(
    process.argv.includes('--dry-run')
      ? 'Dry run — nothing was uploaded.'
      : 'Published. publish/current.json now carries a permits block.',
  );
}

function mib(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
