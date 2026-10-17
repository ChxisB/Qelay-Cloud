import type { z } from 'zod';
import { ApiError } from '../errors';

const tooLarge = (limit: number): ApiError =>
  new ApiError(413, 'payload_too_large', `the request body is larger than ${limit} bytes`, {
    maxBytes: limit,
  });

/** Rejects a declared length over the cap before a byte is read. */
export function checkDeclaredLength(request: Request, limit: number): void {
  const declared = request.headers.get('content-length');
  if (declared === null) return;
  const length = Number(declared);
  if (!Number.isFinite(length) || length < 0) throw ApiError.invalid('bad Content-Length');
  if (length > limit) throw tooLarge(limit);
}

/** The body as text, stopping as soon as it passes `limit` bytes, whatever Content-Length said. */
export async function readText(request: Request, limit: number): Promise<string> {
  checkDeclaredLength(request, limit);
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function issues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Reads a JSON body under the cap and validates it. A body that is not JSON, not UTF-8, or does not
 * fit the schema is a 400; the schema's messages name the field and the expectation, never the
 * rejected value.
 */
export async function readJson<T>(
  request: Request,
  limit: number,
  schema: z.ZodType<T>
): Promise<T> {
  const type = request.headers.get('content-type');
  let text: string;
  try {
    text = await readText(request, limit);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.invalid('the request body is not valid UTF-8');
  }
  let value: unknown;
  if (text !== '') {
    if (type === null || !/^application\/json\s*(;|$)/i.test(type)) {
      throw new ApiError(415, 'unsupported_media_type', 'send the body as application/json');
    }
    try {
      value = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'invalid_json', 'the request body is not valid JSON');
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw ApiError.invalid('the request body does not match the expected shape', {
      issues: issues(parsed.error),
    });
  }
  return parsed.data;
}

export function readQuery<T>(url: URL, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw ApiError.invalid('the query string does not match the expected shape', {
      issues: issues(parsed.error),
    });
  }
  return parsed.data;
}
