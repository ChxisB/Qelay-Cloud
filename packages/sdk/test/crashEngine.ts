/**
 * A workflow `Engine` in its own process, for the crash tests. It starts one run, prints `RUN <id>`
 * and a line for every step, compensation and workflow event, and kills itself (SIGKILL, so nothing is flushed or
 * closed) at the point the plan names. It rings its own bell, since a `MemoryTransport` is private to
 * a process.
 *
 * Arguments: database url, schema, namespace, queue, flow (`forward` or `rollback`), plan.
 *
 * A plan is `<when>:<name>`:
 * - `in-step:b`: the body of step `b` has started and the process dies in it;
 * - `after-step:a`: the record of step `a` is written, the next node is not published;
 * - `in-compensation:b`: the handler of step `b` has started and the process dies in it;
 * - `before-compensation:a`: the handler before `a` is recorded and `a` has not started.
 */
import { writeSync } from 'node:fs';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { Engine } from '../src';
import type { Probe } from './crashFlow';
import { forwardFlow, rollbackFlow } from './crashFlow';

const [url, schema, namespace, queueName, flow, plan] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  'forward' | 'rollback',
  string,
];
const [when, target] = plan.split(':') as [string, string];

const say = (line: string) => void writeSync(1, `${line}\n`);
const die = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
};

const probe: Probe = {
  step(name, key) {
    say(`STEP ${name} ${key}`);
    if (when === 'in-step' && name === target) die();
  },
  compensate(name, key, forwardKey) {
    say(`COMPENSATE ${name} ${key} ${forwardKey}`);
    if (when === 'in-compensation' && name === target) die();
  },
};

const transport = new MemoryTransport();
setInterval(() => transport.tick(), 10);
const engine = new Engine({
  databaseUrl: url,
  database: { schema, poolSize: 3 },
  namespace,
  transport,
  queueName,
  concurrency: 2,
  heartbeatMs: 100,
  onEvent: (event) => {
    // The run id first: the process may die before `start()` returns.
    if (event.type === 'workflow:started') say(`RUN ${event.executionId}`);
    const step = 'stepName' in event ? event.stepName : '-';
    const attempt = 'attempt' in event ? event.attempt : '-';
    say(`EVENT ${event.type} ${step} ${attempt}`);
    if (when === 'after-step' && event.type === 'step:completed' && step === target) die();
    if (
      when === 'before-compensation' &&
      event.type === 'compensation:started' &&
      step === target
    ) {
      die();
    }
  },
});
const definition = flow === 'forward' ? forwardFlow(probe) : rollbackFlow(probe);
await engine.register(definition);
await engine.start(definition.name, {});
