// The checks every payload parser makes: a value is what the page will render, or the response is refused.
const MAX_DATE_MS = 8_640_000_000_000_000;

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown, max: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/** Text a person typed in a box: like `text`, but tabs and line breaks are allowed and an empty value is. */
export function multilineText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length > max) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return false;
  }
  return true;
}

export function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function timestamp(value: unknown): value is number {
  return count(value) && value <= MAX_DATE_MS;
}

export function optionalText(value: unknown, max: number): value is string | null {
  return value === null || text(value, max);
}

export function stringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  const unique = new Set<string>();
  for (const item of value) {
    if (!text(item, maxLength) || unique.has(item)) return false;
    unique.add(item);
  }
  return true;
}

export function payloadData(value: unknown, label: string): Record<string, unknown> {
  const root = record(value);
  const data = root && record(root.data);
  if (root?.ok !== true || !data) throw new Error(`Malformed ${label} response.`);
  return data;
}
