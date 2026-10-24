export type BodyRead =
  | { readonly kind: 'ok'; readonly body: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'timeout' };

/**
 * Reads the body as it arrives and stops at the first byte past `maxBytes` or when `timeoutMs` has gone, whatever the
 * request said about its length: a lying `Content-Length`, or a chunked body that never ends, cannot hold memory or a
 * connection.
 */
export async function readBody(
  request: Request,
  maxBytes: number,
  timeoutMs: number
): Promise<BodyRead> {
  if (request.body === null) return { kind: 'ok', body: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), late]);
      if (step === 'timeout') return { kind: 'timeout' };
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) return { kind: 'too_large' };
      chunks.push(step.value);
    }
  } catch {
    // The client went away mid-body: nobody is left to answer, and what arrived is not a request.
    return { kind: 'timeout' };
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return { kind: 'ok', body };
}
