import { type WorkerRow, WorkersTable } from '../src/pages/control/workers/WorkersTable';
import { answerConfirms } from './confirmSupport';
import {
  act,
  createElement,
  createRoot,
  describe,
  expect,
  installTestHooks,
  json,
  MemoryRouter,
  type ReactElement,
  settle,
  test,
  WorkersPro,
} from './server-action-pages.helpers';

// Monitor: Workers and Alerts. Both removals ask in the page and send the same call as before; a row that goes
// stays 180ms and leaves; a poll that changes nothing animates nothing. happy-dom plays no animation, so these
// check classes, element identity and when an element goes away.

installTestHooks();

function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (next: ReactElement) =>
    act(() => root.render(createElement(MemoryRouter, null, next)));
  show(element);
  return {
    host,
    show,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const rowOf = (host: ParentNode, text: string) =>
  [...host.querySelectorAll<HTMLElement>('tbody tr')].find((tr) => tr.textContent?.includes(text));
const leaves = async () => {
  await settle(60);
  await settle(260);
};

const wire = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  queues: ['orders'],
  concurrency: 1,
  hostname: 'worker.test',
  pid: 42,
  status: 'stale',
  registeredAt: Date.now() - 1_000,
  activeJobs: 0,
  processedJobs: 1,
  failedJobs: 0,
  lastSeen: Date.now(),
  currentJob: null,
  uptime: 1_000,
  ...over,
});

/** A registry that a DELETE really changes, so the poll after a removal shows what is left. */
function serve(registry: { workers: unknown[]; deletes: string[] }) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/workers') && method === 'GET') {
      return Promise.resolve(json({ ok: true, data: { workers: registry.workers } }));
    }
    const id = /\/workers\/([^/]+)$/.exec(url)?.[1];
    if (id && method === 'DELETE') {
      registry.deletes.push(id);
      registry.workers = registry.workers.filter((w) => (w as { id: string }).id !== id);
      return Promise.resolve(json({ ok: true }));
    }
    return Promise.resolve(json({ ok: false, error: `Unexpected ${method} ${url}` }, 500));
  }) as typeof fetch;
}

describe('removing a worker record', () => {
  test('it asks in the page; no sends nothing, yes sends the one call, the row leaves and the message rises in', async () => {
    const registry = { workers: [wire('w-1'), wire('w-2')], deletes: [] as string[] };
    serve(registry);
    const view = mount(createElement(WorkersPro));
    await settle(20);
    const remove = (id: string) =>
      view.host.querySelector(`button[aria-label="Remove stale registry record for worker ${id}"]`);

    const no = answerConfirms(false);
    click(remove('w-1'));
    await settle(20);
    no.stop();
    expect(no.questions).toEqual([
      {
        question: 'Remove the stale registry record for worker "w-1"?',
        confirmLabel: 'Remove record',
        danger: true,
      },
    ]);
    expect(registry.deletes).toEqual([]);
    expect(view.host.textContent).not.toContain('Worker removed');

    const yes = answerConfirms(true);
    click(remove('w-1'));
    await settle(20);
    yes.stop();
    expect(registry.deletes).toEqual(['w-1']);

    const message = view.host.querySelector('[role="status"]');
    expect(message?.textContent).toContain('Removed stale registry record for w-1');
    expect(message?.textContent).not.toContain('✓');
    expect(message?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(message?.classList.contains('motion-arrive')).toBe(true);

    const leaving = rowOf(view.host, 'w-1');
    expect(leaving?.classList.contains('motion-leave')).toBe(true);
    expect(leaving?.hasAttribute('inert')).toBe(true);
    expect(rowOf(view.host, 'w-2')?.classList.contains('motion-leave')).toBe(false);
    expect([...view.host.querySelectorAll('.motion-flash')].map((el) => el.textContent)).toContain(
      '1'
    );

    await leaves();
    expect(rowOf(view.host, 'w-1')).toBeUndefined();
    expect(rowOf(view.host, 'w-2')).toBeDefined();
    view.unmount();
  });

  test('a stale and a quarantined worker each say it in a word and a glyph; with neither there is no such line', async () => {
    const registry = {
      workers: [wire('w-live', { status: 'active' }), wire('w-gone'), { id: 'bad', name: 5 }],
      deletes: [] as string[],
    };
    serve(registry);
    const view = mount(createElement(WorkersPro));
    await settle(20);
    const line = (text: string) =>
      [...view.host.querySelectorAll('span')].find((span) => span.textContent === text);
    expect(line('No heartbeat recently')?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(line('Cannot be shown')?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    view.unmount();

    serve({ workers: [wire('w-live', { status: 'active' })], deletes: [] });
    const calm = mount(createElement(WorkersPro));
    await settle(20);
    expect(calm.host.textContent).not.toContain('No heartbeat recently');
    expect(calm.host.textContent).not.toContain('Cannot be shown');
    calm.unmount();
  });
});

describe('workers table', () => {
  const row = (id: string, over: Partial<WorkerRow> = {}): WorkerRow => ({
    id,
    name: id,
    queues: ['q'],
    status: 'active',
    activeJobs: 0,
    processedJobs: 1,
    failedJobs: 0,
    lastSeen: Date.now(),
    ...over,
  });
  const table = (rows: WorkerRow[]) =>
    createElement(WorkersTable, {
      rows,
      canOperate: false,
      sort: null,
      onSort: () => {},
      busyIds: new Set<string>(),
      onRemove: () => {},
    });
  const ids = (host: ParentNode) =>
    [...host.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('.font-mono')?.textContent);

  test('the first load rises in order; a poll that changes nothing replaces nothing; one moved count washes once', () => {
    const view = mount(table([row('a'), row('b')]));
    const rows = () => [...view.host.querySelectorAll<HTMLElement>('tbody tr')];
    expect(
      rows().map((tr) => [tr.classList.contains('motion-arrive'), tr.style.getPropertyValue('--i')])
    ).toEqual([
      [true, '0'],
      [true, '1'],
    ]);
    const before = rows();

    view.show(table([row('a'), row('b')]));
    expect(rows()).toEqual(before);
    expect(view.host.querySelectorAll('.motion-flash')).toHaveLength(0);
    expect(rows().some((tr) => tr.classList.contains('motion-leave'))).toBe(false);

    view.show(table([row('a'), row('b', { processedJobs: 7 })]));
    expect(rows()).toEqual(before);
    expect([...view.host.querySelectorAll('.motion-flash')].map((el) => el.textContent)).toEqual([
      '7',
    ]);
    view.unmount();
  });

  test('a worker whose queue is not known still has its row, with a dash for the queue', () => {
    const view = mount(table([row('lost', { queues: [] })]));
    expect(rowOf(view.host, 'lost')?.cells[1]?.textContent).toBe('—');
    view.unmount();
  });

  test('a sorted list follows its new order, and a row that is gone keeps its slot while it leaves', async () => {
    const view = mount(table([row('a'), row('b'), row('c')]));
    view.show(table([row('c'), row('b'), row('a')]));
    expect(ids(view.host)).toEqual(['c', 'b', 'a']);

    view.show(table([row('c'), row('a')]));
    expect(ids(view.host)).toEqual(['c', 'b', 'a']);
    expect(rowOf(view.host, 'b')?.classList.contains('motion-leave')).toBe(true);
    await leaves();
    expect(ids(view.host)).toEqual(['c', 'a']);
    view.unmount();
  });
});
