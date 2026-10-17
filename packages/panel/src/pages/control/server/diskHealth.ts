/** What `GET /storage` says about the server's disk, reduced to what the Storage panel shows. */
export type DiskHealth = { ok: true } | { ok: false; message: string };

/**
 * Reads the `{ ok, data: { diskFull, error } }` body of `/storage`. Anything that does not
 * carry a boolean `diskFull` is "unknown" (null): the panel then says nothing about the disk
 * instead of claiming it is healthy.
 */
export function diskHealthOf(response: unknown): DiskHealth | null {
  const data = (response as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { diskFull, error } = data as { diskFull?: unknown; error?: unknown };
  if (typeof diskFull !== 'boolean') return null;
  const detail = typeof error === 'string' && error ? error : null;
  if (diskFull) return { ok: false, message: detail ? `Disk full · ${detail}` : 'Disk full' };
  if (detail) return { ok: false, message: `Write error · ${detail}` };
  return { ok: true };
}
