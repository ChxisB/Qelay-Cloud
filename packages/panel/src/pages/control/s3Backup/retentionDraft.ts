import { useState } from 'react';
import { isValidS3Retention } from '@/components/dashboard/stores/s3Store';

/** Blank text is NaN (not 0) so validation reports it instead of guessing a value. */
export function parseRetentionDraft(text: string): number {
  const trimmed = text.trim();
  return trimmed ? Number(trimmed) : Number.NaN;
}

/**
 * Raw "Backups to retain" text. The persisted store only receives valid values
 * (it snaps anything else to its default), so the draft — not the store — feeds
 * buildS3Environment and an out-of-range entry surfaces as an error instead of
 * silently becoming 7.
 */
export function useRetentionDraft(stored: number, commit: (retention: number) => void) {
  const [draft, setDraft] = useState(() => ({ text: String(stored), base: stored }));
  // A store value changed elsewhere (rehydration) replaces a stale draft.
  const text = draft.base === stored ? draft.text : String(stored);
  return {
    text,
    value: parseRetentionDraft(text),
    change(next: string) {
      const value = parseRetentionDraft(next);
      const valid = isValidS3Retention(value);
      if (valid) commit(value);
      setDraft({ text: next, base: valid ? value : stored });
    },
  };
}
