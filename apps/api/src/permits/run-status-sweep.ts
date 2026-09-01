/**
 * Operator driver for a Source B status sweep without the state machine.
 *
 * The deployed SeminolePermitHarvest definition still plans through an older PlanSweep
 * (no `statusRefreshDays`) and an older PlanStatus (no RR/BPRF ∪ description union).
 * Driving the current planner + harvest against the same S3 prefixes is the resume path
 * those modules already export.
 */
import { harvestStatusBatch } from './harvest-status';
import { WafBlockedError } from './http';
import { planStatusSweep } from './plan-status';
import { statusBatchKey } from './storage';

function say(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

async function main(): Promise<void> {
  const runId =
    process.env.STATUS_RUN_ID ?? `roof-newest-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const limit = Number(process.env.STATUS_PERMIT_LIMIT ?? '45000');
  const refreshDays = Number(process.env.STATUS_REFRESH_DAYS ?? '7');
  const startBatch = Number(process.env.STATUS_START_BATCH ?? '0');
  const order = process.env.STATUS_ORDER === 'oldest' ? 'oldest' : 'newest';
  const fromMonth = process.env.STATUS_FROM_MONTH ?? '2024-09';

  const worklistRun = process.env.STATUS_WORKLIST_RUN;
  const probeLevels = (process.env.STATUS_PROBE_LEVELS ?? '')
    .split(',')
    .map((level) => Number(level.trim()))
    .filter((level) => Number.isFinite(level) && level >= 1);

  say(
    `run ${runId} limit=${limit} refreshDays=${refreshDays} startBatch=${startBatch} ` +
      `order=${order} fromMonth=${fromMonth} ` +
      `concurrency=${process.env.SOURCE_B_CONCURRENCY ?? 'default'}` +
      (worklistRun !== undefined && worklistRun !== '' ? ` worklist=${worklistRun}` : ''),
  );

  /**
   * Reuse a worklist already spilled to S3. Planning re-reads the whole census; a concurrency
   * probe does not need that — it needs application numbers that are already queued.
   */
  let batches: Awaited<ReturnType<typeof planStatusSweep>>['batches'];
  if (worklistRun !== undefined && worklistRun !== '') {
    const count =
      probeLevels.length > 0
        ? probeLevels.length
        : Number(process.env.STATUS_WORKLIST_COUNT ?? '1');
    batches = Array.from({ length: count }, (_, index) => {
      const batchIndex = startBatch + index;
      return {
        runId,
        batchKey: statusBatchKey({ runId: worklistRun, batchIndex }),
        batchIndex,
        permitCount: 150,
      };
    });
    say(`skip plan — ${count} existing batches from ${worklistRun} starting at ${startBatch}`);
  } else {
    const plan = await planStatusSweep({
      runId,
      scope: {
        statusFromMonth: fromMonth,
        statusPermitLimit: limit,
        statusOrder: order,
        statusRoofingOnly: true,
        statusRefreshDays: refreshDays,
      },
    });
    say(
      JSON.stringify({
        selected: plan.selected,
        candidates: plan.candidates,
        skippedTerminal: plan.skippedTerminal,
        skippedFresh: plan.skippedFresh,
        skippedNonRoofing: plan.skippedNonRoofing,
        truncated: plan.truncated,
        batches: plan.batches.length,
        selectedFrom: plan.selectedFrom,
        selectedTo: plan.selectedTo,
        candidateSource: plan.candidateSource,
        roofingRuleCounts: plan.roofingRuleCounts,
      }),
    );
    batches = plan.batches.slice(startBatch);
  }

  const started = Date.now();
  let harvested = 0;
  for (const [index, batch] of batches.entries()) {
    if (probeLevels.length > 0) {
      const level = probeLevels[Math.min(index, probeLevels.length - 1)];
      process.env.SOURCE_B_CONCURRENCY = String(level);
      say(`probe concurrency=${level} batch=${batch.batchIndex}`);
    }
    const batchStarted = Date.now();
    const result = await harvestStatusBatch(batch);
    harvested += result.permitsHarvested;
    const batchMin = (Date.now() - batchStarted) / 60_000;
    const elapsedMin = (Date.now() - started) / 60_000;
    const batchRate = result.permitsHarvested / Math.max(batchMin, 0.001);
    const rate = harvested / Math.max(elapsedMin, 0.001);
    say(
      `batch ${batch.batchIndex} harvested=${result.permitsHarvested} ` +
        `open=${result.openPermits} closed=${result.closedPermits} skippedTerminal=${result.permitsSkippedTerminal} ` +
        `total=${harvested} batchRate=${batchRate.toFixed(1)}/min overall=${rate.toFixed(1)}/min ` +
        `medianMs=${result.latencyMs.median}`,
    );
    if (result.warnings.length > 0) say(`warnings ${result.warnings.join('; ')}`);
    if (probeLevels.length > 0 && index + 1 >= probeLevels.length) {
      say(`probe complete lastConcurrency=${process.env.SOURCE_B_CONCURRENCY}`);
      break;
    }
  }
  say(`done harvested=${harvested}`);
}

main().catch((error: unknown) => {
  if (error instanceof WafBlockedError) {
    say(`WAF BLOCK — stopping: ${error.message}`);
    process.exit(2);
  }
  say(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
