import { parseSealKey, STRICT_URL_POLICY, UnsupportedOptionError } from '@qelay-cloud/core';
import type { WebhookUrlPolicy } from '@qelay-cloud/core';

type Env = Readonly<Record<string, string | undefined>>;

/** What every process that touches webhooks reads the same way: the Control API and the tick. */
export interface WebhookEnvSettings {
  /**
   * `QCLOUD_WEBHOOK_KEY`: 32 bytes as 64 hex digits or base64, the key secrets are sealed with. Absent:
   * a webhook cannot be given a secret. Keep it in the cloud secret manager, apart from the database.
   */
  readonly key?: string;
  /**
   * `QCLOUD_WEBHOOK_DEV_MODE=true` allows `http:` and loopback or private destinations, so a
   * webhook can deliver to a receiver on localhost. Anything else is the strict policy.
   */
  readonly urlPolicy: WebhookUrlPolicy;
  /** `QCLOUD_WEBHOOK_KEEP_MS`: how long a finished delivery stays readable. Absent: two days. The tick uses it; the Control API ignores it. */
  readonly keepMs?: number;
}

/** Throws `UnsupportedOptionError` naming the variable, and never repeats the key. */
export function webhookSettingsFromEnv(env: Env): WebhookEnvSettings {
  const raw = env.QCLOUD_WEBHOOK_KEY;
  const mode = (env.QCLOUD_WEBHOOK_DEV_MODE ?? '').trim().toLowerCase();
  if (!['', '0', 'false', '1', 'true'].includes(mode)) {
    throw new UnsupportedOptionError('QCLOUD_WEBHOOK_DEV_MODE', 'must be true or false');
  }
  const urlPolicy: WebhookUrlPolicy =
    mode === '1' || mode === 'true' ? { allowHttp: true, allowPrivate: true } : STRICT_URL_POLICY;
  const keep = env.QCLOUD_WEBHOOK_KEEP_MS;
  if (keep !== undefined && keep !== '' && !/^[1-9]\d*$/.test(keep)) {
    throw new UnsupportedOptionError(
      'QCLOUD_WEBHOOK_KEEP_MS',
      `must be a positive integer, not "${keep}"`
    );
  }
  const keepMs = keep === undefined || keep === '' ? {} : { keepMs: Number(keep) };
  if (raw === undefined || raw.trim() === '') return { urlPolicy, ...keepMs };
  parseSealKey(raw, 'QCLOUD_WEBHOOK_KEY');
  return { key: raw, urlPolicy, ...keepMs };
}
