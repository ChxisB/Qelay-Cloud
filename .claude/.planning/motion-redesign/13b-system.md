# 13b — System: Server, Database, S3 backup, MCP and the queue consoles

**Status:** done · **Depends on:** 03, 04b, 05 · **Touches:** packages/panel/src (pages/control/ServerControl, server/*, Database, database/*, S3BackupPro, s3Backup/*, McpServer, mcp/*, features/backups/ui, features/queue-operations/ui), components/SystemTabs.tsx, test, e2e
**Design:** https://claude.ai/artifact/TMMbZ97jDRzvSpWiFVKRuG, boards "System" and the System part of "SystemMore" (SY1 to SY10)

## Goal
Show the managed server and its backups with the shared parts, and move six confirms into the page, including the typed-word Restore.

## Steps
1. Read the boards, `DESIGN-MAP.md` ("System", SY1 to SY10) and the files above with their tests.
2. Server: the running dot's halo plays once (SY2, the panel looped it); uptime moves on without a flash, memory and connection
   counts flash only on change (SY3); server states keep a glyph and a word (SY4); the log tail slides new lines in, Follow and
   Times work as today (SY5).
3. Replace these six call sites with `confirmInPage`, same API calls and same blast-radius wording (SY1):
   `ServerControl.tsx` (line 63, Stop and Restart), `server/ConfigCard.tsx` (line 182, Save & restart),
   `BackupOperationsPanel.tsx` (lines 113 and 121, Apply and Create a backup),
   `QueueTelemetryConsole.tsx` (line 40) and `QueueDeduplicationConsole.tsx` (line 26). Titles that the board adds are new
   wording, approved 2026-10-22.
4. Restore keeps its typed word, asked in the dialog with the 04b typed-word variant: the confirm button stays off until the
   word matches, and Restore stays unavailable while the managed server is running (SY7).
5. Database: no write control (SY6). Export and the row drawer stay. MCP keeps its "destructive tools" warning; the tool total
   is counted from the groups shown (SY8).
6. Edit the tests and e2e that stub the dialog or pin old markup in the same change.

## Acceptance
- All six confirms ask in the page, call the same API on true and nothing on false; the typed-word Restore sends nothing until
  the word matches exactly.
- Restore is still blocked while the managed server runs.
- The Database page has no write control.
- The halo plays once; an unchanged poll animates nothing.

## Verify
```bash
bun test packages/panel/test/server- packages/panel/test/backup- packages/panel/test/database-page packages/panel/test/mcp-reference packages/panel/test/queue-operations packages/panel/test/system-tabs packages/panel/test/s3store packages/panel/test/queue-settings-operations-hidden.test.tsx packages/panel/test/mutation-action-guards packages/panel/test/motion-guard.test.ts && bun run typecheck && bun run lint && bun run format:check
```

## Risks / notes
- This task may pass 8 files. If it does, split it into 13b (server, MCP, database) and 13e (backups and the queue consoles) in
  the status table.
- `window.confirm` was synchronous: check that Stop and Restart disable their button between the click and the answer, so a
  double click cannot send twice.
- The backup concurrency tests (`backup-operation-concurrency`, `backup-operation-ownership`) stub the dialog; they change here.

## Result
Done 2026-10-22, as one task (the split into 13b and 13e was not needed).

**What changed**
- Eight asks now go through `confirmInPage`, same API calls as before: Stop, Restart and Save & restart (`ServerControl`, `server/ConfigCard`, `server/configEditor.restartQuestion`), Apply, Backup now and Restore (`BackupOperationsPanel`, new `useScopedConfirm`), Remove key (`QueueDeduplicationConsole`) and Trim journal (`QueueTelemetryConsole`). Restore asks for the typed word `RESTORE` in the dialog (the 04b `typedWord` variant), and after the answer re-reads the live context: the managed server must still be stopped and the database path the same, else nothing is sent.
- Server tab: halo rings once when the server turns healthy (`useChangeFlash(haloOn)`, no ring on a page that opens on a healthy server or on unchanged polls); Memory and Connections wash only on a real change, the uptime never does; the log tail slides new lines in (`useFreshAfter`, at most 8 per poll, read once per line so a filter, Times or a quiet poll replay nothing).
- MCP sample path is `./data/qelay.db` (was `bunq.db`). SY4 (glyph and word) and SY6 (no Database write control) needed no change.

**Choices to know**
- Stop, Restart and Save & restart take their lease first and ask inside it (`ServerControl.run`, `ConfigCard.persist`), so a double click cannot open two questions or send twice. This differs from the "ask first, then begin" order in `WorkersPro` and `QueuesOverview`; the backup panel and the queue consoles keep ask-then-run with a scope check.
- `ConfigCard` checks the draft and the conflict before it asks, so an invalid draft shows its error and opens no dialog.
- Known limit, not fixed: `useFreshAfter` keeps the previous head until the next change, so flipping the stream filter straight after an arrival can replay up to 8 just-arrived lines.

**Tests**
- New: `backup-restore-confirm` (2), `server-confirm` (5), `server-motion` (6). `answerConfirms()` replaces `window.confirm` stubs in `control-operation-hardening.part-08/10/11`, `backup-operations-ui` and `queue-operations-ui`.
- Six test files went over the 300-line cap while editing and were split (helpers moved, tests unchanged): `health-motion` and `health-motion-tables`, `alerts-workers-motion` and `alerts-motion`, `gateway-connection-settings` and `gateway-connection-secret`, `ui-motion` and `ui-motion-table`, `shell-motion` and `shell-motion-menu`, and `queue-operations-ui` with `queue-operations-ui.support`.

**What ran** (emulator-free, no Docker, no Postgres, no browser)
- 13b Verify plus the hardening and database-read-only suites: 125 pass, 0 fail, 34 files.
- Full panel suite from the repo root: 2066 pass, 0 fail, 285 files (133 s).
- Panel `bun run typecheck`, root `bun run lint` (no errors), `bun run format:check` and `bun run architecture` (1790 files within the cap) all clean.

**Not run:** the rest of the repo gate and other packages, Postgres-backed tests, e2e, `dev:stub` by eye. The motion is unit-tested by class and element identity only; the halo ring on the 10px server dot and the log-line slide inside the scrolling viewer have not been seen in a browser. Wording that needs the owner's word is listed in DESIGN-MAP.md under "System outcome".

**Left for later tasks:** other tests still stub `window.confirm` or `window.prompt` and did not fail (`benchmark-fixes*`, `control-operation-hardening.part-02..07`, `control-pages-stable-fixes*`, `frontend-a11y-fixes.helpers`, `frontend-blockers-hardening*`, `job-queue-pages-fixes.helpers`, `mutation-action-guards.part-02`, `server-action-pages.helpers`, `confirm-dialog`, and e2e `webhooks`/`workflows`); task 14 removes them with the guard.
