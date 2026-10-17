import type { StateStorage } from 'zustand/middleware';
import { readWithLegacy } from '@/lib/legacyStorage';

interface ResilientStorageOptions {
  key: string;
  /** Pre-rebrand key to adopt once when `key` is absent (see `readWithLegacy`). */
  legacyKey?: string;
  version: number;
  /**
   * Receives the envelope's stored version so version-gated migrations can run
   * before the canonical rewrite stamps the current version over it.
   */
  sanitizeState: (value: unknown, storedVersion?: number) => unknown;
  onError?: (error: unknown) => void;
  reportMissingWrites?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function browserStorage(options: ResilientStorageOptions, writing = false): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage ?? null;
    if (!storage && writing && options.reportMissingWrites) {
      options.onError?.(new Error('localStorage is unavailable'));
    }
    return storage;
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

function sanitizedEnvelope(raw: string, options: ResilientStorageOptions) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = isRecord(parsed) ? parsed : {};
    const storedVersion = typeof envelope.version === 'number' ? envelope.version : undefined;
    const state = options.sanitizeState(
      'state' in envelope ? envelope.state : envelope,
      storedVersion
    );
    return {
      hydration: JSON.stringify({
        state,
        ...(storedVersion === undefined ? {} : { version: storedVersion }),
      }),
      canonical: JSON.stringify({ state, version: options.version }),
    };
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

/** Optional localStorage durability that never lets browser policy break in-memory state. */
export function createResilientStateStorage(options: ResilientStorageOptions): StateStorage {
  const report = (error: unknown) => options.onError?.(error);
  return {
    getItem(name) {
      const storage = browserStorage(options);
      if (!storage) return null;
      let raw: string | null;
      try {
        raw = storage.getItem(name);
      } catch (error) {
        report(error);
        return null;
      }
      if (raw === null && options.legacyKey && name === options.key) {
        raw = readWithLegacy(storage, name, options.legacyKey);
      }
      if (raw === null || name !== options.key) return raw;
      const sanitized = sanitizedEnvelope(raw, options);
      if (!sanitized) {
        try {
          storage.removeItem(name);
        } catch (error) {
          report(error);
        }
        return null;
      }
      if (raw !== sanitized.canonical) {
        try {
          storage.setItem(name, sanitized.canonical);
        } catch (error) {
          report(error);
          // Historical envelopes may contain secrets. Delete rather than retain
          // them when browser policy prevents a canonical rewrite.
          try {
            storage.removeItem(name);
          } catch (removeError) {
            report(removeError);
          }
        }
      }
      return sanitized.hydration;
    },
    setItem(name, value) {
      const storage = browserStorage(options, true);
      if (!storage) return;
      try {
        storage.setItem(name, value);
      } catch (error) {
        report(error);
      }
    },
    removeItem(name) {
      const storage = browserStorage(options);
      if (!storage) return;
      try {
        storage.removeItem(name);
      } catch (error) {
        report(error);
      }
    },
  };
}
