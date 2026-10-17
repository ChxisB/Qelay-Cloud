/**
 * Runs the `bash test` blocks of the documents against a local Postgres, so the commands a reader copies are the commands
 * that were run. The blocks of one file run in order in one `bash`, as the reader's terminal would run them (a block
 * may start a server with `&` and a later block use it), on a database made for the run and dropped after it.
 * Only `PATH`, `HOME` and what the run itself sets reach them: nothing of the developer's cloud credentials does.
 */
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';
import type { MarkdownDoc } from './markdown';
import { ROOT } from './links';

export const DEFAULT_DATABASE_URL = 'postgres://qcloud:qcloud@127.0.0.1:55432/qcloud_test';
/** Ports the quickstarts use. The run needs them free and says so when they are not. */
export const DOC_PORTS = [8080, 8081] as const;
const TIMEOUT_MS = 10 * 60_000;

export interface DocScript {
  readonly file: string;
  readonly blocks: ReadonlyArray<{ readonly line: number; readonly code: string }>;
}

/** The runnable blocks of each document, in order; a document with none has no script. */
export function scriptsOf(docs: readonly MarkdownDoc[], root = ROOT): DocScript[] {
  return docs
    .map((doc) => ({
      file: relative(root, doc.path),
      blocks: doc.fences
        .filter((fence) => fence.lang === 'bash' && fence.flags.includes('test'))
        .map((fence) => ({ line: fence.line, code: fence.body })),
    }))
    .filter((script) => script.blocks.length > 0);
}

export const MARKER = '>>> ';

export function renderScript(script: DocScript): string {
  return [
    'set -euo pipefail',
    'exec 2>&1',
    // Whatever a block started in the background goes with the run, however it ends.
    'cleanup() { local pids; pids=$(jobs -p); if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi; wait 2>/dev/null || true; }',
    'trap cleanup EXIT',
    "trap 'exit 143' TERM INT",
    ...script.blocks.flatMap((block) => [`printf '\\n${MARKER}%s:%d\\n' '${script.file}' ${block.line}`, block.code]),
  ].join('\n');
}

export interface ScriptResult {
  readonly file: string;
  readonly ok: boolean;
  readonly seconds: number;
  /** The `file:line` of the block that was running when it stopped, and the tail of what it printed. */
  readonly failedAt: string | null;
  readonly tail: string;
}

export async function portsInUse(ports: readonly number[]): Promise<number[]> {
  const busy: number[] = [];
  for (const port of ports) {
    try {
      const probe = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') });
      await probe.stop(true);
    } catch {
      busy.push(port);
    }
  }
  return busy;
}

export type Prepared =
  | { readonly ok: true; readonly databaseUrl: string; readonly drop: () => Promise<void> }
  | { readonly ok: false; readonly reason: string };

/** Makes the throwaway database on the server the tests use. */
export async function prepareDatabase(
  adminUrl = process.env.QCLOUD_TEST_DATABASE_URL ?? DEFAULT_DATABASE_URL
): Promise<Prepared> {
  const admin = new SQL({ url: adminUrl, max: 1, connectionTimeout: 5 });
  const name = `qcloud_docs_${randomBytes(5).toString('hex')}`;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.close().catch(() => {});
    return { ok: false, reason: `Postgres is not reachable at the test database URL (${(error as Error).message})` };
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    ok: true,
    databaseUrl: url.toString(),
    drop: async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await admin.close().catch(() => {});
    },
  };
}

export async function runScript(
  script: DocScript,
  databaseUrl: string,
  timeoutMs = Number(process.env.QCLOUD_DOCS_TIMEOUT_MS ?? TIMEOUT_MS)
): Promise<ScriptResult> {
  const started = performance.now();
  const child = Bun.spawn(['bash', '-c', renderScript(script)], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      QCLOUD_DATABASE_URL: databaseUrl,
    },
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  const output = `${out}${err}`;
  const markers = [...output.matchAll(new RegExp(`^${MARKER}(.+)$`, 'gmu'))];
  return {
    file: script.file,
    ok: code === 0,
    seconds: (performance.now() - started) / 1000,
    failedAt: code === 0 ? null : (markers.at(-1)?.[1] ?? null),
    tail: output.split('\n').slice(-40).join('\n'),
  };
}
