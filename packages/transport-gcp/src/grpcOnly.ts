/**
 * Keeps a Pub/Sub client on gRPC, which streaming pull needs. Left unset, the Google client libraries
 * switch to their browser transport whenever a `window` with a `fetch` exists (the panel's tests register
 * one, and `bun test` runs every file in one process), and that transport signs in with Application
 * Default Credentials even against an emulator.
 *
 * `google-gax` reads the option, but the library's `ClientConfig` type does not declare it, so it is
 * spread into the options instead of being written inline.
 */
export const GRPC_ONLY = { fallback: false } as const;
