/** What to log for anything a `catch` can hold. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A thrown value as an `Error`, for an `error` event. */
export const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
