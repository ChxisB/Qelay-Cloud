#!/usr/bin/env bun
/**
 * The smoke test of a deployed control plane (task 36). It signs in, adds a job, watches it
 * complete over the event stream, triggers the tick and reads `/deployment`.
 *
 *   bun run scripts/smoke-gcp.ts --local
 *       The same entrypoints the images run, as processes on this machine: a throwaway schema of a
 *       local Postgres ($QCLOUD_SMOKE_DATABASE_URL, else $QCLOUD_TEST_DATABASE_URL), the Postgres
 *       doorbell, a loopback issuer. It also runs the migration and rollback drills. It does not
 *       build or run a container, and it never talks to Google Cloud.
 *
 *   QCLOUD_SMOKE_TOKEN=<an OIDC access token of a test principal with the operator role> \
 *   bun run scripts/smoke-gcp.ts --api-url https://<name>-api-<project number>.<region>.run.app \
 *       [--panel-url https://...] [--queue qcloud-smoke] [--scheduler-job <name> --region <r> --project <p>] \
 *       [--tick-wait-sec 150]
 *       A deployed environment (needs the go-ahead for decision D9: this script is not run by a
 *       task). The queue needs a worker that completes jobs. With --scheduler-job the tick is
 *       triggered with `gcloud scheduler jobs run` (a write to your project); without it the script
 *       waits for the scheduler's next run. The token is read from the environment, sent only as an
 *       Authorization header, and never printed.
 *
 * Exit 0: every check passed. 1: a check failed. 2: usage.
 */
import { Report, SmokeFailure, expect } from './smoke-lib';
import { common, parse, runLocal } from './smoke-steps';

async function runDeployed(report: Report, flags: Map<string, string>): Promise<void> {
  const token = process.env.QCLOUD_SMOKE_TOKEN;
  if (token === undefined || token === '') throw new Error('QCLOUD_SMOKE_TOKEN is not set');
  const apiUrl = flags.get('api-url');
  if (apiUrl === undefined) throw new Error('--api-url is required (or --local)');
  const job = flags.get('scheduler-job');
  const region = flags.get('region');
  const project = flags.get('project');
  if (job !== undefined && (region === undefined || project === undefined)) {
    throw new Error('--scheduler-job needs --region and --project');
  }
  await common(report, {
    apiUrl,
    panelUrl: flags.get('panel-url') ?? null,
    token,
    queue: flags.get('queue') ?? 'qcloud-smoke',
    production: true,
    tickWaitMs: Number(flags.get('tick-wait-sec') ?? '150') * 1_000,
    async triggerTick() {
      if (job === undefined) return "waiting for the scheduler's next run";
      const child = Bun.spawn(
        ['gcloud', 'scheduler', 'jobs', 'run', job, `--location=${region}`, `--project=${project}`, '--quiet'],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const code = await child.exited;
      expect(code === 0, `gcloud scheduler jobs run exited ${code}`);
      return `gcloud scheduler jobs run ${job}`;
    },
  });
}

let flags: Map<string, string>;
try {
  flags = parse(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  console.error('usage: bun run scripts/smoke-gcp.ts --local | --api-url <url> (see the file header)');
  process.exit(2);
}

const report = new Report();
try {
  if (flags.has('local')) await runLocal(report, { transport: 'postgres' });
  else await runDeployed(report, flags);
} catch (error) {
  if (!(error instanceof SmokeFailure)) {
    console.error(error instanceof Error ? error.message : String(error));
    if (report.outcomes.length > 0) report.print((line) => console.log(line));
    process.exit(2);
  }
}
report.print((line) => console.log(line));
process.exit(report.failed ? 1 : 0);
