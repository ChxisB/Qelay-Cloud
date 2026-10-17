/**
 * Real-engine harness for the workflow state-machine model.
 *
 * Every run gets a namespace and a `MemoryTransport` of its own on one shared, migrated schema. The
 * engine is real (Postgres store, queue, worker), next to a background copy of the maintenance tick
 * (`runTick`): a timed `waitFor` expires on it, and it re-rings a job whose bell a closing worker
 * spent. `restart()` is the stand-in for a crash: force-close, reopen over the same rows, recover.
 * The real kill -9 paths are in `packages/sdk/test/workflow.crash.test.ts`.
 *
 * **Changed from upstream:** Postgres instead of a SQLite file; async engine methods; the tick
 * replaces the in-memory wait timers; `restart()` recovers with `idleMs: 0`, because a restarted
 * engine is the only driver of its rows.
 */

import type { TickConfig } from '../../../packages/maintenance/src';
import { transportWindowMs } from '../../../packages/maintenance/src';
import type { Execution } from '../../../packages/sdk/src';
import { Engine } from '../../../packages/sdk/src';
import { openDatabase, PostgresStore } from '../../../packages/store-postgres/src';
import { MemoryTransport } from '../../../packages/transport-local/src';
import { testDatabaseUrl } from '../../support/db';
import { buildChildWorkflows, buildWorkflow } from './build';
import {
  disposeCampaign,
  finished,
  listAllExecutions,
  modelTickConfig,
  nextNamespace,
  operatorRace,
  sharedSchema,
  tickOnce,
} from './harnessSupport';
import { checkInvariants, type InvariantState } from './invariants';
import { emptyLedger, type Ledger, type WorkflowSpec } from './spec';

export { disposeCampaign };

export interface WorkflowModel {
  /** The model starts every run before applying generated operator actions. */
  implicitStart: true;
}

/** A running node writes its run this often; the tick takes a run only after `IDLE_MS` of silence. */
const HEARTBEAT_MS = 25;
const IDLE_MS = 1_000;
const SWEEP_EVERY_MS = 30;

export class RealWorkflow {
  private engine: Engine;
  private engineGeneration = 0;
  readonly ledger: Ledger = emptyLedger();
  readonly invariants: InvariantState;
  runId: string | null = null;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private sweeping = false;
  private readonly tickConfig: TickConfig;

  private constructor(
    readonly spec: WorkflowSpec,
    private readonly schema: string,
    private readonly namespace: string,
    private readonly queueName: string,
    private readonly transport: MemoryTransport,
    private readonly sweepStore: PostgresStore
  ) {
    this.tickConfig = modelTickConfig(transport, sweepStore);
    this.invariants = {
      spec,
      ledger: this.ledger,
      delivered: new Map(),
      maxNodeIndex: new Map(),
      terminalStates: new Map(),
      settled: false,
    };
    this.engine = this.openEngine();
    // A MemoryTransport has no clock of its own: this is what a broker does for a delayed bell.
    this.timers.push(setInterval(() => this.transport.tick(), 10));
    this.timers.push(setInterval(() => void this.sweep(), SWEEP_EVERY_MS));
  }

  static async create(spec: WorkflowSpec, tag: string): Promise<RealWorkflow> {
    const { name } = await sharedSchema();
    const namespace = nextNamespace();
    const transport = new MemoryTransport();
    const db = openDatabase({ url: testDatabaseUrl(), schema: name, poolSize: 2 });
    const store = new PostgresStore({ db, namespace, ringWindowMs: transportWindowMs(transport) });
    // Unique workflow name so a recover never touches another run's rows.
    const scoped: WorkflowSpec = { ...spec, name: `gen_${tag}` };
    return new RealWorkflow(scoped, name, namespace, `__wf:model:${tag}`, transport, store);
  }

  private openEngine(): Engine {
    const engine = new Engine({
      databaseUrl: testDatabaseUrl(),
      database: { schema: this.schema, poolSize: 3 },
      namespace: this.namespace,
      transport: this.transport,
      queueName: this.queueName,
      concurrency: 2,
      heartbeatMs: HEARTBEAT_MS,
      recoverIdleMs: IDLE_MS,
    });
    // Children first: a parent's subWorkflow node resolves its child by name at run time.
    const children = buildChildWorkflows(this.spec, this.ledger, this.engineGeneration);
    const parent = buildWorkflow(this.spec, this.ledger, this.engineGeneration);
    this.registering = (async () => {
      for (const child of children) await engine.register(child);
      await engine.register(parent);
    })();
    return engine;
  }

  /** The registration of the engine opened last; awaited before the engine is used. */
  private registering: Promise<void> = Promise.resolve();

  /**
   * One pass of the maintenance tick: it re-rings a job whose bell a closing worker spent, expires
   * overdue waits and takes runs whose engine went silent.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await tickOnce(this.sweepStore, this.transport, this.tickConfig, this.queueName, IDLE_MS);
    } finally {
      this.sweeping = false;
    }
  }

  async start(): Promise<void> {
    await this.registering;
    const run = await this.engine.start(this.spec.name, { seed: 1 });
    this.runId = run.id;
    await this.check();
  }

  async signal(event: string, payload: unknown): Promise<void> {
    if (!this.runId) return;
    try {
      await this.engine.signal(this.runId, event, payload);
      // Only accepted deliveries enter the oracle. Signals are first-wins, so a rejected
      // duplicate must preserve the original expected payload.
      this.invariants.delivered.set(event, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/cannot receive the signal|was already received/.test(message)) throw err;
    }
  }

  /** Let the engine make progress, then assert every invariant. */
  async settle(ms: number): Promise<void> {
    await Bun.sleep(ms);
    await this.check();
  }

  /** Close and reopen over the same rows: the model's crash and restart. */
  async restart(): Promise<void> {
    await this.engine.close(true);
    this.engineGeneration++;
    this.engine = this.openEngine();
    await this.registering;
    await this.engine.recover({ idleMs: 0 });
    await this.check();
  }

  /**
   * `recover()` on a LIVE engine, with nothing closed. It takes only runs that have been silent for
   * the idle window, so it must leave the node the engine is driving alone.
   */
  async recoverLive(): Promise<void> {
    await this.engine.recover();
    await this.check();
  }

  /** `recover()` aimed at the window where an unwind is in flight. A no-op when none is. */
  async recoverDuringUnwind(): Promise<void> {
    const deadline = Date.now() + 250;
    while (Date.now() < deadline) {
      if ((await this.execution())?.state === 'compensating') {
        await this.engine.recover();
        await this.check();
        return;
      }
      await Bun.sleep(2);
    }
  }

  async resumeCompensation(): Promise<void> {
    if (!this.runId) return;
    await this.operate('resume', this.runId);
    await this.check();
  }

  async abandonCompensation(): Promise<void> {
    if (!this.runId) return;
    await this.operate('abandon', this.runId);
    await this.check();
  }

  async execution(): Promise<Execution | null> {
    return this.runId ? await this.engine.getExecution(this.runId) : null;
  }

  async check(): Promise<void> {
    const related = await this.relatedExecutions();
    checkInvariants(
      this.invariants,
      related.find((exec) => exec.id === this.runId) ?? null,
      related
    );
  }

  /**
   * Final liveness gate. Untimed gates are opened, timed gates are allowed to expire, and parked
   * rollbacks receive one retry followed by an explicit abandon. Every generated graph must reach a
   * real terminal state; `waiting` and `compensation-stuck` cannot make a vacuous campaign pass.
   */
  async assertSettles(): Promise<void> {
    if (!this.runId) throw new Error('NON-VACUOUS violated: generated run was never started');
    await this.openUntimedGates();
    const resumed = new Set<string>();
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const related = await this.relatedExecutions();
      for (const exec of related.filter((candidate) => candidate.state === 'compensation-stuck')) {
        if (!resumed.has(exec.id)) {
          resumed.add(exec.id);
          await this.operate('resume', exec.id);
        } else {
          await this.operate('abandon', exec.id);
        }
      }
      await this.check();
      const settled = related.length > 0 && related.every(finished);
      if (settled) {
        // Terminal: a failed run must now say what its rollback did.
        this.invariants.settled = true;
        await this.check();
        return;
      }
      await Bun.sleep(25);
    }
    await this.check();
    const states = (await this.relatedExecutions()).map((exec) => `${exec.id}:${exec.state}`);
    throw new Error(
      `LIVENESS violated: executions did not terminate (${states.join(', ')})\n` +
        `spec=${JSON.stringify(this.spec)}\nledger=${JSON.stringify(this.ledger)}`
    );
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    await this.engine.close(true);
    await this.sweepStore.close({ timeout: 1000 }).catch(() => {});
    await this.transport.close();
  }

  private async relatedExecutions(): Promise<Execution[]> {
    if (!this.runId) return [];
    const all = await listAllExecutions(this.engine);
    const ids = new Set([this.runId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const exec of all) {
        if (exec.parentExecutionId && ids.has(exec.parentExecutionId) && !ids.has(exec.id)) {
          ids.add(exec.id);
          changed = true;
        }
      }
    }
    return all.filter((exec) => ids.has(exec.id));
  }

  private async openUntimedGates(): Promise<void> {
    const events = new Set(
      this.spec.nodes.flatMap((node) =>
        node.kind === 'waitFor' && node.timeout === undefined ? [node.event] : []
      )
    );
    for (const event of events) {
      if (!this.invariants.delivered.has(event)) {
        await this.signal(event, { modelFinalizer: true });
      }
    }
  }

  /** An operator action on a parked unwind; losing the race to the engine is not a failure. */
  private async operate(kind: 'resume' | 'abandon', executionId: string): Promise<void> {
    if ((await this.engine.getExecution(executionId))?.state !== 'compensation-stuck') return;
    this.ledger.operatorActions.push({ kind, executionId });
    try {
      if (kind === 'resume') await this.engine.resumeCompensation(executionId);
      else await this.engine.abandonCompensation(executionId);
    } catch (error) {
      if (!operatorRace(error)) throw error;
    }
  }
}
