/**
 * Long pause around a Source B outage for the operator driver.
 *
 * The Lambda path must not sleep here — a 15-minute timeout cannot absorb a 20-minute
 * wait, and Step Functions already owns that retry. The overnight sweep is a long-lived
 * process, so it sits until the portal serves pages again instead of exiting and
 * replanning from batch 0 every 45 seconds.
 */
import { SOURCE_B_UNAVAILABLE_RETRY_MS } from './config';
import { harvestStatusBatch } from './harvest-status';
import { sleep, TransientRequestError, WafBlockedError } from './http';
import type { StatusBatch, StatusBatchResult } from './model';
import { PermitSourceUnavailableError, probeSourceB } from './source-b';

export function isRetryableSourceBFailure(error: unknown): boolean {
  return (
    error instanceof PermitSourceUnavailableError || error instanceof TransientRequestError
  );
}

export function sourceBUnavailableRetryMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SOURCE_B_UNAVAILABLE_RETRY_MS;
  if (raw === undefined || raw === '') return SOURCE_B_UNAVAILABLE_RETRY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : SOURCE_B_UNAVAILABLE_RETRY_MS;
}

export async function harvestStatusBatchWhenReady(
  batch: StatusBatch,
  deps: {
    harvest?: (next: StatusBatch) => Promise<StatusBatchResult>;
    probe?: () => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    retryMs?: number;
    log?: (line: string) => void;
  } = {},
): Promise<StatusBatchResult> {
  const harvest = deps.harvest ?? harvestStatusBatch;
  const probe = deps.probe ?? probeSourceB;
  const wait = deps.sleep ?? sleep;
  const retryMs = deps.retryMs ?? sourceBUnavailableRetryMs();
  let attempt = 0;

  for (;;) {
    try {
      await probe();
      return await harvest(batch);
    } catch (error) {
      if (error instanceof WafBlockedError) throw error;
      if (!isRetryableSourceBFailure(error)) throw error;
      attempt += 1;
      const reason = error instanceof Error ? error.message : String(error);
      const waitLabel =
        retryMs >= 60_000
          ? `${Math.round(retryMs / 60_000)}m`
          : `${Math.round(retryMs / 1000)}s`;
      deps.log?.(
        `Click2Gov unavailable — wait ${waitLabel} then retry batch ${batch.batchIndex} (attempt ${attempt}): ${reason}`,
      );
      await wait(retryMs);
    }
  }
}
