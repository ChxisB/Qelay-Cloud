import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { Lines } from '../../sdk/test/childLines';
import { until } from '../../sdk/test/workerSupport';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';

const CHILD = `${import.meta.dir}/loopChild.ts`;
const INTERVAL = 200;
const LEASE = 1_000;
/** Scheduling slack on a loaded machine: process wake-ups, a pooled connection, a GC pause. */
const SLACK = 600;

interface Tick {
  readonly holder: string;
  readonly at: number;
}

/**
 * Several real processes, each running the in-process tick loop on real timers against the
 * database's clock, as a fleet of workers would. A killed process cannot release its lease, so
 * what is measured is the takeover a crash leaves to the lease's own expiry.
 */
describeDb('TickLoop election across processes (real timers, the database clock)', () => {
  let t: TestStore;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  beforeAll(async () => {
    t = await openTestStore({ clock: null, ringWindowMs: 3_600_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    // Only the lease row matters here; the database clock has no manual clock to rewind.
    await t.fresh.sql`TRUNCATE qcloud_tick_state`;
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  function spawnLoop(holder: string) {
    const child = Bun.spawn(
      [
        'bun',
        CHILD,
        testDatabaseUrl(),
        t.fresh.name,
        'test',
        holder,
        String(INTERVAL),
        String(LEASE),
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' }
    );
    children.push(child);
    return { holder, child, lines: new Lines(child.stdout as ReadableStream<Uint8Array>) };
  }
  type Loop = ReturnType<typeof spawnLoop>;

  /** Starts a loop per holder and waits until every one has done its first beat. */
  async function fleet(...holders: string[]): Promise<Loop[]> {
    const loops = holders.map(spawnLoop);
    for (const { holder, lines } of loops) {
      await until(`${holder} to be ready`, () => lines.all.includes('READY'), 20_000);
    }
    return loops;
  }

  const ticksOf = (loops: readonly Loop[]): Tick[] =>
    loops
      .flatMap(({ lines }) => lines.all)
      .filter((line) => line.startsWith('TICK '))
      .map((line) => {
        const [, holder, at] = line.split(' ') as [string, string, string];
        return { holder, at: Number(at) };
      })
      .sort((a, b) => a.at - b.at);

  const errorsOf = (loops: readonly Loop[]): string[] =>
    loops.flatMap(({ lines }) => lines.all).filter((line) => line.startsWith('ERROR '));

  /** Polls the lease row until `done` holds; returns the elapsed time and the status that satisfied it. */
  async function waitFor(done: (leader: string | null) => boolean, what: string) {
    const started = performance.now();
    const status = await until(
      what,
      async () => {
        const read = await t.store.maintenance.tickStatus();
        return done(read.leader) ? read : null;
      },
      10_000
    );
    return { elapsedMs: performance.now() - started, status };
  }

  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  test('three processes: one holds the lease continuously and it alone ticks', async () => {
    const loops = await fleet('a', 'b', 'c');
    const leaders = new Set<string | null>();
    let gaps = 0;
    for (let n = 0; n < 60; n += 1) {
      const status = await t.store.maintenance.tickStatus();
      leaders.add(status.leader);
      if ((status.leaderExpiresAt ?? 0) <= status.now) gaps += 1;
      await pause(25);
    }
    expect(leaders.size).toBe(1);
    expect([...leaders][0]).toMatch(/^[abc]$/);
    // The lease never lapsed between renewals, so nobody else had a chance to take it.
    expect(gaps).toBe(0);

    const ticks = ticksOf(loops);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ticks.map((tick) => tick.holder)).size).toBe(1);
    expect(ticks[0]!.holder).toBe([...leaders][0]!);
    expect(errorsOf(loops)).toEqual([]);
  }, 60_000);

  test('SIGKILL of the leader: another process leads about one lease later, never before the lease ran out', async () => {
    const loops = await fleet('a', 'b', 'c');
    await pause(2 * INTERVAL);
    const before = await t.store.maintenance.tickStatus();
    const dead = loops.find((loop) => loop.holder === before.leader)!;
    expect(dead).toBeDefined();

    dead.child.kill('SIGKILL');
    await dead.child.exited;
    const { elapsedMs, status } = await waitFor(
      (leader) => leader !== null && leader !== dead.holder,
      'a follower to take the lease'
    );

    // Not early, in the database's own time: the dead leader's last renewal had not yet run out.
    expect(status.now).toBeGreaterThanOrEqual(before.leaderExpiresAt!);
    // The last renewal was at most an interval before the kill, and a follower beats every
    // interval, so the takeover comes within lease + interval of the kill.
    expect(elapsedMs).toBeLessThanOrEqual(LEASE + INTERVAL + SLACK);
    expect(elapsedMs).toBeGreaterThanOrEqual(LEASE - INTERVAL - 150);

    await pause(3 * INTERVAL);
    const ticks = ticksOf(loops);
    const lastDead = ticks.filter((tick) => tick.holder === dead.holder).at(-1)!;
    const afterwards = ticks.filter((tick) => tick.at > lastDead.at);
    expect(afterwards.length).toBeGreaterThanOrEqual(2);
    // One successor, and it stayed the only one ticking.
    expect(new Set(afterwards.map((tick) => tick.holder)).size).toBe(1);
    expect(afterwards[0]!.holder).not.toBe(dead.holder);
    // The two never ticked within a lease of each other: a lease is a promise of exclusivity.
    expect(afterwards[0]!.at - lastDead.at).toBeGreaterThanOrEqual(LEASE - 150);
    expect(errorsOf(loops)).toEqual([]);
  }, 60_000);

  test('the leader asked to stop gives the lease up, so a follower leads within an interval or two, not a lease', async () => {
    const loops = await fleet('a', 'b', 'c');
    await pause(2 * INTERVAL);
    const before = await t.store.maintenance.tickStatus();
    const leaving = loops.find((loop) => loop.holder === before.leader)!;

    leaving.child.kill('SIGTERM');
    const { elapsedMs } = await waitFor(
      (leader) => leader !== null && leader !== leaving.holder,
      'a follower to take over'
    );
    await until('the leader to report it stopped', () => leaving.lines.all.includes('STOPPED'));
    await leaving.child.exited;

    expect(elapsedMs).toBeLessThanOrEqual(2 * INTERVAL + SLACK);
    expect(elapsedMs).toBeLessThan(LEASE - INTERVAL);
    expect(errorsOf(loops)).toEqual([]);
  }, 60_000);

  test('a process that joins late follows, and the lease never changes hands while the leader lives', async () => {
    const [first] = await fleet('a');
    await pause(2 * INTERVAL);
    const before = await t.store.maintenance.tickStatus();
    expect(before.leader).toBe('a');

    const late = await fleet('b', 'c');
    for (let n = 0; n < 40; n += 1) {
      expect((await t.store.maintenance.tickStatus()).leader).toBe('a');
      await pause(25);
    }
    expect(new Set(ticksOf([first!, ...late]).map((tick) => tick.holder))).toEqual(new Set(['a']));
  }, 60_000);
});
