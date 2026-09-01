import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SERVICE_NAME } from '@oracle-seminole/shared';
import { logger, tracer } from '../observability';

const PAGERDUTY_ENQUEUE_URL = 'https://events.pagerduty.com/v2/enqueue';
const ACCEPTED_STATUS = 202;

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

export interface PagerDutyTrigger {
  summary: string;
  source: string;
  severity?: PagerDutySeverity;
  dedupKey?: string;
  customDetails?: Record<string, unknown>;
}

export interface PagerDutyTriggerResult {
  /** `suppressed` means paging is disabled for this environment; nothing was sent. */
  status: 'triggered' | 'suppressed';
  dedupKey?: string;
}

const secretsClient = tracer.captureAWSv3Client(new SecretsManagerClient({}));

/**
 * The routing key is cached for the life of the container so a burst of alerts does
 * not fan out into a burst of Secrets Manager reads. It is never logged and never
 * placed in an environment variable — only the secret's ARN is configured.
 */
let cachedRoutingKey: string | undefined;

function pagingEnabled(): boolean {
  return process.env.PAGERDUTY_ENABLED === 'true';
}

async function resolveRoutingKey(): Promise<string> {
  if (cachedRoutingKey) {
    return cachedRoutingKey;
  }

  const secretArn = process.env.PAGERDUTY_SECRET_ARN;
  if (!secretArn) {
    throw new Error('PAGERDUTY_SECRET_ARN is not configured');
  }

  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error('PagerDuty secret has no string value');
  }

  const parsed: unknown = JSON.parse(response.SecretString);
  const routingKey =
    typeof parsed === 'object' && parsed !== null && 'routingKey' in parsed
      ? (parsed as { routingKey?: unknown }).routingKey
      : undefined;

  if (typeof routingKey !== 'string' || routingKey.length === 0) {
    throw new Error('PagerDuty secret is missing a routingKey field');
  }

  cachedRoutingKey = routingKey;
  return routingKey;
}

/**
 * Sends a PagerDuty Events API v2 `trigger`. Only HTTP 202 counts as accepted;
 * anything else throws so the caller's failure path (DLQ, Step Functions `Fail`)
 * stays honest about the page not having landed.
 */
export async function triggerPagerDuty(alert: PagerDutyTrigger): Promise<PagerDutyTriggerResult> {
  if (!pagingEnabled()) {
    logger.warn('PagerDuty paging is disabled for this environment; alert not sent', {
      summary: alert.summary,
      source: alert.source,
    });
    return { status: 'suppressed' };
  }

  const routingKey = await resolveRoutingKey();

  const response = await fetch(PAGERDUTY_ENQUEUE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: alert.dedupKey,
      payload: {
        summary: alert.summary,
        source: alert.source,
        severity: alert.severity ?? 'critical',
        component: SERVICE_NAME,
        custom_details: alert.customDetails ?? {},
      },
    }),
  });

  const bodyText = await response.text();

  if (response.status !== ACCEPTED_STATUS) {
    throw new Error(`PagerDuty rejected the event with status ${response.status}: ${bodyText}`);
  }

  const parsed: unknown = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  const dedupKey =
    typeof parsed === 'object' && parsed !== null && 'dedup_key' in parsed
      ? (parsed as { dedup_key?: unknown }).dedup_key
      : undefined;

  logger.info('PagerDuty event accepted', {
    source: alert.source,
    dedupKey: typeof dedupKey === 'string' ? dedupKey : undefined,
  });

  return { status: 'triggered', dedupKey: typeof dedupKey === 'string' ? dedupKey : undefined };
}
