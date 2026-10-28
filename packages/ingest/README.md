# @qelay-cloud/ingest

The public listener of the event gateway (D12, D14). A sender POSTs whatever it likes to `/s/<token>`; the ingest checks
the source's verification, stores the request, and answers. The routes of that source then deliver it to their
destinations: the tick sends, the ingest never calls out, so it needs no outbound network and holds no job state.

It runs on `Bun.serve` with no framework and no dependency beyond `@qelay-cloud/core` and `@qelay-cloud/store-postgres`
(`bun run architecture` fails if it imports anything else). Any number of instances can run side by side.

## Run

```bash
QCLOUD_DATABASE_URL=… QCLOUD_WEBHOOK_KEY=… bun packages/ingest/src/bin.ts
```

It takes no arguments. The settings are in [docs/reference/configuration.md](../../docs/reference/configuration.md#ingest);
a setting that cannot work stops the process with exit code 2 and a message that never repeats its value. The schema is
migrated by `qcloud-api migrate`, not here.

## What a request goes through

In this order; a step that refuses ends the request, and the answer never says which source exists.

| Step | Answer |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`, no database call |
| Path is not `/s/qin_` + 43 base64url characters | 404 |
| Method is not `POST`, `PUT`, `PATCH` or `DELETE` | 405, `Allow` set |
| Over the global rate (before any lookup) | 429, `Retry-After` |
| Token unknown, source off or deleted | 404 (one answer for all three) |
| Over the source's rate | 429, not stored |
| Declared or streamed body over the cap | 413, stored as a rejection |
| Body not delivered in time | 408, stored as a rejection |
| Verification fails | 401, stored as a rejection |
| Database cannot be reached | 503, `Retry-After` |
| Otherwise | 200 `{"id":"…"}`, the request stored and one delivery made per route |

A rejection keeps its cause and the redacted headers and query, never the body, and the store keeps at most 60 per source
per minute (the rest are counted). No shape on a route means the destination gets the request's bytes and content type
unchanged.

Verification is `none`, `hmac` (SHA-256 over the raw body, hex or base64, with an optional `sha256=` prefix; the current
and the rotated-out secret both pass during the grace), `basic` or `api_key`. Secrets are compared by digest in constant
time.

## Limits that are known

Rate limits are counted per process, so `n` instances allow about `n` times the figure; the edge (task 09) is where a
per-address limit belongs. A flood of well-shaped random tokens costs one indexed lookup each until the global limit
answers.
