import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openJobsFixture } from '../../packages/control-api/test/jobsFixture';
import type { JobsFixture } from '../../packages/control-api/test/jobsFixture';
import { reconcile, untilFinished } from '../scenarios/scenario';
import { openStack } from '../scenarios/stack';
import type { Stack } from '../scenarios/stack';
import { describeDb } from '../support/db';

const PAYLOAD = 'CANARY-payload-5d1c9e';
const SECRET = 'CANARY-secret-8b2f4a';

/** The call sites that write a log line. Their arguments may name ids, counts, queues and error text, never a job's data. */
const FORBIDDEN =
  /\b(data|payload|returnvalue|returnValue|password|secret|token|databaseUrl|connectionString|body)\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'node_modules' || name === 'test' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The text inside the parentheses of each `warn(`/`error(` call on a logger. */
function logCalls(text: string): string[] {
  const calls: string[] = [];
  const start = /(?:logger\??\.|rt\.|this\.#|options\.logger\?\.|host\.rt\.)(?:warn|error)\(/g;
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < text.length) {
      const ch = text[end++];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    calls.push(text.slice(match.index, end));
  }
  return calls;
}

describe('logs: the call sites', () => {
  const roots = [
    'sdk',
    'control-api',
    'ingest',
    'maintenance',
    'store-postgres',
    'telemetry',
    'webhooks',
  ].map((name) => join(import.meta.dir, '../../packages', name, 'src'));
  const files = roots.flatMap((root) => {
    try {
      return sources(root);
    } catch {
      return [];
    }
  });

  test('there are log calls to check', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap((file) => logCalls(readFileSync(file, 'utf8'))).length).toBeGreaterThan(
      15
    );
  });

  test('no log call names a payload, a return value, a token or a connection string', () => {
    const offenders = files.flatMap((file) =>
      logCalls(readFileSync(file, 'utf8'))
        // Message text may say "token refused"; only the fields are checked.
        .map((call) => call.replace(/(['"`])(?:(?!\1).)*\1/g, "''"))
        .filter((call) => FORBIDDEN.test(call))
        .map((call) => `${file.replace(/.*packages\//, '')}: ${call.replace(/\s+/g, ' ')}`)
    );
    expect(offenders).toEqual([]);
  });
});

describeDb('logs: what a run writes', () => {
  let s: Stack;
  let fixture: JobsFixture;
  beforeAll(async () => {
    s = await openStack('memory', { tickIntervalMs: 100 });
    fixture = await openJobsFixture();
  });
  afterAll(async () => {
    await s.stopTicks();
    await s.drop();
    await fixture.drop();
  });

  test('the SDK logs carry no payload and say which job, on a run with a lost publish and a failing processor', async () => {
    const lines: Array<{ message: string; context?: Readonly<Record<string, unknown>> }> = [];
    const logger = {
      warn: (message: string, context?: Readonly<Record<string, unknown>>) =>
        void lines.push({ message, ...(context === undefined ? {} : { context }) }),
    };
    const queue = s.queue({ logger });
    s.worker(
      async (job) => {
        if (job.name === 'declined') throw new Error(`declined ${PAYLOAD}`);
        return { receipt: PAYLOAD };
      },
      { logger }
    );
    s.ring.failNext(1);
    const jobs = [
      await queue.add('declined', { card: PAYLOAD, key: SECRET }),
      await queue.add('paid', { card: PAYLOAD, key: SECRET }),
    ];
    await untilFinished(
      s,
      jobs.map((job) => job.id)
    );
    await reconcile(
      s,
      jobs.map((job) => job.id)
    );
    expect(lines.length).toBeGreaterThan(0);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(PAYLOAD);
    expect(text).not.toContain(SECRET);
    for (const line of lines) {
      expect(line.message.length).toBeGreaterThan(0);
      // A line about one job names it; one about many says how many.
      if (/job|bell/.test(line.message)) {
        expect(Boolean(line.context?.jobId) || typeof line.context?.count === 'number').toBe(true);
      }
    }
  });

  test('the Control API logs one structured record per request, with the route and not the path, the body or the token', async () => {
    const api = fixture.api();
    await api.call('POST', '/queues/orders/jobs', {
      name: 'charge',
      data: { card: PAYLOAD, key: SECRET },
    });
    await api.call('POST', `/queues/${SECRET}/jobs`, { name: 'x', data: { card: PAYLOAD } });
    await api.call('GET', `/jobs/${SECRET}`);
    await api.call('POST', '/queues/orders/jobs', { nope: PAYLOAD });
    const response = await api.api.call('GET', '/queues', { token: SECRET });
    expect(response.status).toBe(401);
    const { requests, errors, warnings } = api.api.recorded;
    expect(requests.length).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify({ requests, errors, warnings });
    expect(text).not.toContain(PAYLOAD);
    expect(text).not.toContain(SECRET);
    for (const record of requests) {
      expect(record.requestId.length).toBeGreaterThan(0);
      expect(record.route).not.toMatch(/CANARY/);
    }
  });
});
