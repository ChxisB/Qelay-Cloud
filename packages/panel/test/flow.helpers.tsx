import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { FlowRepository } from '../src/features/flows/application/FlowRepository';
import type {
  FlowActionBody,
  FlowActionResult,
  FlowList,
  FlowNode,
  FlowView,
} from '../src/features/flows/domain/flowWire';
import { useCapabilitiesStore } from '../src/lib/capabilities/store';
import { DEMO_CAPABILITIES } from '../src/lib/capabilities/types';
import { ensureDom } from './domSetup';

export const T0 = 1_800_000_000_000;

export function node(id: string, overrides: Partial<FlowNode> = {}): FlowNode {
  return {
    id,
    queue: 'orders',
    state: 'completed',
    version: 1,
    parentId: null,
    depth: 0,
    attempts: 1,
    createdAt: T0,
    completedAt: T0 + 1_000,
    error: null,
    mode: null,
    blocking: false,
    removed: false,
    ...overrides,
  };
}

export function flowView(nodes: FlowNode[], overrides: Partial<FlowView> = {}): FlowView {
  return {
    root: nodes[0]!.id,
    nodes,
    total: nodes.length,
    truncated: false,
    limit: 1_000,
    failures: [],
    ...overrides,
  };
}

/** A parent that waits for two children: one done, one failed for good with no policy, so it holds the parent. */
export function stuckFlow(): FlowView {
  return flowView([
    node('root', { state: 'waiting-children', version: 4, attempts: 0 }),
    node('ok', { parentId: 'root', depth: 1, version: 3, mode: 'fail' }),
    node('bad', {
      parentId: 'root',
      depth: 1,
      state: 'failed',
      version: 5,
      attempts: 3,
      error: 'SMTP 550: mailbox unavailable',
      blocking: true,
    }),
  ]);
}

/** `count` jobs in a ten-way tree below `n0`; `n<failedIndex>` has failed and holds its parent. */
export function syntheticFlow(count: number, failedIndex = count - 1): FlowView {
  const nodes: FlowNode[] = [node('n0', { state: 'waiting-children', attempts: 0 })];
  const depths = [0];
  for (let index = 1; index < count; index += 1) {
    const parent = Math.floor((index - 1) / 10);
    const depth = depths[parent]! + 1;
    depths.push(depth);
    nodes.push(
      node(`n${index}`, {
        parentId: `n${parent}`,
        depth,
        ...(index === failedIndex
          ? { state: 'failed', error: 'boom', blocking: true, attempts: 2 }
          : {}),
      })
    );
  }
  return flowView(nodes);
}

export function flowList(overrides: Partial<FlowList> = {}): FlowList {
  return {
    flows: [
      {
        id: 'root',
        queue: 'orders',
        name: 'process-order',
        state: 'waiting-children',
        createdAt: T0,
        version: 4,
        total: 3,
        states: { completed: 1, failed: 1, 'waiting-children': 1 },
        blocked: 1,
      },
    ],
    total: 1,
    limit: 25,
    offset: 0,
    ...overrides,
  };
}

export interface FlowCalls {
  lists: Array<{ limit: number; offset: number }>;
  views: Array<{ root: string; limit: number }>;
  acts: Array<{ root: string; body: FlowActionBody }>;
  rootOfs: string[];
}

type Maybe<T> = T | Promise<T>;

export interface FakeFlowRepository extends FlowRepository {
  readonly calls: FlowCalls;
}

/** A repository whose answers each test decides; every call is recorded. */
export function fakeRepository(
  parts: {
    list?: () => Maybe<FlowList>;
    view?: (root: string, limit: number) => Maybe<FlowView>;
    act?: (root: string, body: FlowActionBody) => Maybe<FlowActionResult>;
    rootOf?: (id: string) => Maybe<string | null>;
  } = {}
): FakeFlowRepository {
  const calls: FlowCalls = { lists: [], views: [], acts: [], rootOfs: [] };
  return {
    calls,
    async list(page) {
      calls.lists.push(page);
      return (parts.list ?? (() => flowList()))();
    },
    async view(root, limit) {
      calls.views.push({ root, limit });
      if (!parts.view) throw new Error('view was not expected');
      return parts.view(root, limit);
    },
    async rootOf(id) {
      calls.rootOfs.push(id);
      return parts.rootOf ? parts.rootOf(id) : null;
    },
    async act(_target, root, body) {
      calls.acts.push({ root, body });
      if (!parts.act) throw new Error('act was not expected');
      return parts.act(root, body);
    },
  };
}

const mounted = new Set<() => void>();

/** Unmounts everything `mountFlows` rendered; call it from `afterEach`. */
export function unmountAll(): void {
  for (const unmount of [...mounted]) unmount();
}

/** Renders `element` under a router at `path`; `search()` is the address's query as the page left it. */
export function mountFlows(element: ReactElement, path = '/flows') {
  ensureDom();
  const where = { search: '' };
  function Probe(): null {
    where.search = useLocation().search;
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() =>
    root.render(
      createElement(MemoryRouter, { initialEntries: [path] }, element, createElement(Probe))
    )
  );
  return { host, search: () => where.search, text: () => host.textContent ?? '', unmount };
}

/**
 * The jobs of a flow start as a graph on a wide screen and as the list on a narrow one. The page tests that
 * read the list (a tree with its keys) run narrow; a test of the graph sets a wide screen.
 */
export function setScreenWidth(width: number): void {
  ensureDom();
  (window as unknown as { happyDOM: { setViewport: (size: object) => void } }).happyDOM.setViewport(
    { width, height: 800 }
  );
}

export function connectTo(baseUrl = 'http://server-a.test'): void {
  useConnectionStore.setState({ baseUrl, token: 'flow-token', agentToken: '', refreshMs: 60_000 });
}

export function disconnect(): void {
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
}

export function serveRole(role: 'operator' | 'viewer'): void {
  useCapabilitiesStore.setState({
    status: 'ready',
    caps: { ...DEMO_CAPABILITIES, principal: { role } },
    error: null,
    key: 'test',
  });
}

/** The tree's lines (those drawn), as `[id, state]`. */
export function treeRows(host: ParentNode): Array<[string, string]> {
  return [...host.querySelectorAll('[role="treeitem"]')].map((row) => [
    decodeURIComponent((row.id ?? '').replace('flow-row-', '')),
    row.getAttribute('data-flow-state') ?? '',
  ]);
}

export function treeRow(host: ParentNode, id: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[id="flow-row-${encodeURIComponent(id)}"]`);
  if (!found) throw new Error(`No line for ${id}`);
  return found;
}
