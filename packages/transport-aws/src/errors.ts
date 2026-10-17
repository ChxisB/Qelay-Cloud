interface AwsError {
  readonly name?: string;
  readonly $retryable?: unknown;
  readonly $fault?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

/**
 * Whether a call that threw is worth making again inside a budget: a throttle, a server fault or a
 * network failure is; a refusal the caller must fix (a missing queue, a denied permission, a bad
 * parameter) is not, and waiting would only delay the tick that picks the job up.
 */
export function isTransient(error: unknown): boolean {
  const aws = error as AwsError | null;
  if (aws?.$retryable) return true;
  const status = aws?.$metadata?.httpStatusCode;
  if (typeof status === 'number') return status >= 500 || status === 429 || status === 408;
  return aws?.$fault !== 'client';
}

/** The error codes SQS answers for a receipt handle that is no longer valid. */
const STALE_HANDLE = new Set([
  'ReceiptHandleIsInvalid',
  'MessageNotInflight',
  'InvalidParameterValue',
  'InvalidParameterValueException',
]);

export function isStaleHandle(error: unknown): boolean {
  const name = (error as AwsError | null)?.name;
  return name !== undefined && STALE_HANDLE.has(name);
}
