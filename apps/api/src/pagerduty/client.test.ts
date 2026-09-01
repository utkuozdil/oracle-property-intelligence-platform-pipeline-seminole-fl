import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secretsMock = mockClient(SecretsManagerClient);

async function loadClient() {
  vi.resetModules();
  return import('./client');
}

beforeEach(() => {
  secretsMock.reset();
  process.env.PAGERDUTY_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-2:795366345505:secret:oracle-seminole/pagerduty-abc123';
});

afterEach(() => {
  secretsMock.reset();
  vi.unstubAllGlobals();
  delete process.env.PAGERDUTY_ENABLED;
});

describe('triggerPagerDuty', () => {
  it('suppresses the page when paging is not enabled for the environment', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { triggerPagerDuty } = await loadClient();

    const result = await triggerPagerDuty({ summary: 'stub', source: 'test' });

    expect(result).toEqual({ status: 'suppressed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats 202 as accepted and captures the dedup key', async () => {
    process.env.PAGERDUTY_ENABLED = 'true';
    secretsMock
      .on(GetSecretValueCommand)
      .resolves({ SecretString: JSON.stringify({ routingKey: 'routing-key-from-secret' }) });
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 202,
      text: async () => JSON.stringify({ status: 'success', dedup_key: 'dedup-9' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { triggerPagerDuty } = await loadClient();

    const result = await triggerPagerDuty({ summary: 'boom', source: 'state-machine' });

    expect(result).toEqual({ status: 'triggered', dedupKey: 'dedup-9' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(JSON.parse(String(init.body))).toMatchObject({
      routing_key: 'routing-key-from-secret',
      event_action: 'trigger',
      payload: { summary: 'boom', source: 'state-machine', severity: 'critical' },
    });
  });

  it('throws on any non-202 response so the failure is not swallowed', async () => {
    process.env.PAGERDUTY_ENABLED = 'true';
    secretsMock
      .on(GetSecretValueCommand)
      .resolves({ SecretString: JSON.stringify({ routingKey: 'routing-key-from-secret' }) });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 400, text: async () => 'invalid routing key' }),
    );
    const { triggerPagerDuty } = await loadClient();

    await expect(triggerPagerDuty({ summary: 'boom', source: 'test' })).rejects.toThrow(
      'PagerDuty rejected the event with status 400',
    );
  });

  it('fails loudly when the secret does not carry a routingKey', async () => {
    process.env.PAGERDUTY_ENABLED = 'true';
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({}) });
    vi.stubGlobal('fetch', vi.fn());
    const { triggerPagerDuty } = await loadClient();

    await expect(triggerPagerDuty({ summary: 'boom', source: 'test' })).rejects.toThrow(
      'missing a routingKey field',
    );
  });
});
