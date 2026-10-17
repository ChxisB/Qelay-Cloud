/**
 * Pre-rebrand localStorage keys. A hard rename would silently reset a user's
 * theme, alert rules, connection profiles, S3 settings and assistant config, so
 * every reader adopts the old value once (see `readWithLegacy`). This is the only
 * place in `src/` that may spell the old product name.
 */
export const LEGACY_STORAGE_KEYS = {
  theme: 'bq-dash-theme',
  alerts: 'bq-dash-alerts',
  connection: 'bq-dash-connection',
  copilot: 'bq-dash-copilot',
  s3: 'bq-dash-s3',
  dbHistory: 'bq-dash-db-history',
} as const;

/**
 * Read `key`; when it is absent, adopt `legacyKey`'s raw string: copy it to `key`,
 * then remove `legacyKey`. The copy is byte-for-byte, so a store's own sanitiser and
 * versioning still run on the migrated value.
 *
 * - An existing `key` always wins and `legacyKey` is left alone, so nothing is
 *   overwritten and nothing is deleted that was not copied.
 * - If the copy cannot be written (full or blocked storage) the legacy value is
 *   still returned and kept, so this session works and the next load retries.
 * - Never throws.
 */
export function readWithLegacy(storage: Storage, key: string, legacyKey: string): string | null {
  try {
    const current = storage.getItem(key);
    if (current !== null) return current;
    const legacy = storage.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      storage.setItem(key, legacy);
      storage.removeItem(legacyKey);
    } catch {
      // Keep the legacy copy; the migration retries on the next read.
    }
    return legacy;
  } catch {
    return null;
  }
}
