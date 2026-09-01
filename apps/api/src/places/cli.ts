#!/usr/bin/env node
/**
 * The runnable entry point, and the thing a presenter executes on camera.
 *
 * It is a thin shell over `runPlaces`, which is the same function the scheduled Lambda
 * calls. That matters more than it looks: the numbers in the findings document were measured
 * here, and a separate code path for the cloud would let the deployed run quietly disagree
 * with them.
 *
 * Peer output is read from local directories and nothing is uploaded, so a run needs no AWS
 * credentials and cannot write to the shared bucket by accident.
 *
 * Usage:
 *
 *   pnpm exec tsx src/places/cli.ts ingest [--diff] [--counts-only] [--fail-on-drift]
 *   pnpm exec tsx src/places/cli.ts demo
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OVERTURE_PREVIOUS_RELEASE, OVERTURE_RELEASE, ROOFING_TAXONOMY_PATH } from './config';
import { LocalPeerReader, localPeerRoots } from './peers';
import { runPlaces } from './run';
import { publishedPlacesTableKey, resolveOutputDir } from './storage';

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function ingest(argv: readonly string[]): Promise<void> {
  const outputDir = resolveOutputDir();
  const result = await runPlaces({
    request: {
      diffAgainst: argv.includes('--diff') ? OVERTURE_PREVIOUS_RELEASE : undefined,
      countsOnly: argv.includes('--counts-only'),
      failOnReleaseDrift: argv.includes('--fail-on-drift'),
    },
    peers: new LocalPeerReader(localPeerRoots(outputDir)),
  });

  const { summary, join } = result;
  log(`run                ${summary.runId}`);
  log(
    `release            ${summary.release} (latest: ${summary.releaseDrift.latest ?? 'unknown'})`,
  );
  log(
    `boundary           TIGERweb ${summary.boundary.vintage}, ${summary.boundary.vertices} vertices, ` +
      `sha256 ${summary.boundary.fingerprint.slice(0, 12)}`,
  );
  log(`bbox diagnostic    ${summary.bboxPrunedCount}`);
  log(
    `county-clipped     ${summary.clippedCount}  (rejected by geometry: ${summary.bboxOnlyCount})`,
  );
  log(`distinct GERS ids  ${summary.distinctGersIds}`);
  log(
    `confidence         min ${summary.confidence.min} median ${summary.confidence.median} ` +
      `max ${summary.confidence.max}; below ${summary.recommendedConfidenceFloor}: ` +
      `${summary.rowsBelowRecommendedFloor}`,
  );
  log(
    `roofing            ${summary.roofingCount} (${summary.roofingDistinctNames} distinct names)`,
  );
  log(`content sha        ${summary.contentFingerprint}`);
  log(`licence gate       ${summary.sourceGate.passed ? 'PASS' : 'FAIL'}`);
  for (const dataset of summary.sourceGate.datasets) {
    log(
      `  ${dataset.dataset.padEnd(18)} ${String(dataset.places).padStart(6)}  ${dataset.license}`,
    );
  }
  for (const [jurisdiction, count] of Object.entries(summary.jurisdictionCounts)) {
    log(`  ${jurisdiction.padEnd(32)} ${String(count).padStart(6)}`);
  }
  if (summary.delta) {
    log(
      `delta ${summary.delta.fromRelease} -> ${summary.delta.toRelease}: ` +
        `+${summary.delta.added} -${summary.delta.removed} ~${summary.delta.dataChanged} ` +
        `=${summary.delta.unchanged}`,
    );
  }
  for (const warning of summary.warnings) log(`warning            ${warning}`);
  for (const artifact of summary.artifacts) {
    log(`artifact           ${artifact.key}  ${artifact.rows} rows, ${artifact.bytes} bytes`);
  }
  log(`duckdb             ${result.databasePath}`);
  log(`elapsed            ${summary.elapsedSeconds}s`);

  log('');
  log(`roofing places     ${join.roofingPlaces}`);
  log(
    `permit names       ${join.permitContractorsConsidered}  (${join.denominators.permitContractorSource})`,
  );
  log(
    `bbb businesses     ${join.bbbBusinessesConsidered}  (${join.denominators.bbbBusinessSource})`,
  );
  log(
    `permit match       ${join.placesMatchedToPermits}/${join.roofingPlaces} = ` +
      `${(join.permitMatchRate * 100).toFixed(1)}% at floor ${join.matchFloor}`,
  );
  log(
    `  defensible       ${join.placesMatchedDefensibly}/${join.roofingPlaces} = ` +
      `${(join.defensibleMatchRate * 100).toFixed(1)}% (${join.defensibleTiers.join('/')})`,
  );
  log(
    `  permit-side      ${join.permitContractorsMatched}/${join.permitContractorsConsidered} = ` +
      `${(join.permitContractorMatchRate * 100).toFixed(1)}% of permit contractors reached a business`,
  );
  log(
    `bbb match          ${join.placesMatchedToBbb}/${join.roofingPlaces} = ` +
      `${(join.bbbMatchRate * 100).toFixed(1)}%`,
  );
  log(`permit tiers       ${JSON.stringify(join.permitTierCounts)}`);
  log(`bbb paths          ${JSON.stringify(join.bbbPathCounts)}`);
  log(`matches            ${result.matchesPath}`);
}

/**
 * Prints the demo query, resolved against whatever artifact is on disk.
 *
 * Printed rather than only documented so the command a presenter runs is generated from the
 * same constants the artifact was written with, and cannot drift from it.
 */
function demo(outputDir: string): void {
  const tablePath = join(outputDir, publishedPlacesTableKey(OVERTURE_RELEASE));
  const exists = existsSync(tablePath);
  log(
    `# artifact: ${tablePath}${exists ? ` (${statSync(tablePath).size} bytes)` : ' — not built yet'}`,
  );
  log('');
  log(`duckdb -c "`);
  log(`SELECT jurisdiction, name, address_freeform, round(confidence, 3) AS confidence`);
  log(`FROM read_parquet('${tablePath}')`);
  log(`WHERE taxonomy_hierarchy = '${ROOFING_TAXONOMY_PATH}'`);
  log(`  AND confidence >= 0.6`);
  log(`ORDER BY confidence DESC LIMIT 20;"`);
}

const [command = 'ingest', ...argv] = process.argv.slice(2);

switch (command) {
  case 'ingest':
    await ingest(argv);
    break;
  case 'demo':
    demo(resolveOutputDir());
    break;
  default:
    process.stderr.write(`unknown command: ${command}\n`);
    process.exit(2);
}
