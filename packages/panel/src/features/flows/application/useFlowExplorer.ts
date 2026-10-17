import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { BqError, captureServerRequestTarget, type ServerRequestTarget } from '@/lib/bq';
import {
  allParents,
  ancestorsOf,
  buildFlowTree,
  defaultExpanded,
  type FlowFilter,
  type FlowRow,
  type FlowTree,
  flowRows,
  reopenAfterReload,
} from '../domain/flowTree';
import { flowSearchParams, readFlowUrlState } from '../domain/flowUrlState';
import { DEFAULT_FLOW_VIEW_NODES, type FlowView, MAX_FLOW_VIEW_NODES } from '../domain/flowWire';
import { controlFlowRepository } from '../infrastructure/controlFlowRepository';
import type { FlowRepository } from './FlowRepository';

/** A flow as it was read, and the connection it was read from. */
export interface LoadedFlow {
  readonly root: string;
  readonly connection: string;
  readonly view: FlowView;
  readonly tree: FlowTree;
  /** The connection the operator was looking at: an action is refused if it has changed since. */
  readonly target: ServerRequestTarget;
  readonly expanded: ReadonlySet<string>;
}

const currentConnection = (): string =>
  JSON.stringify([getBaseUrl(), useConnectionStore.getState().token]);

const isNotFound = (error: unknown): boolean =>
  error instanceof BqError && error.status === 404 && error.code === 'flow_not_found';

/** The flow an address names: loaded from the Control API, its tree open or shut, a job selected. */
export function useFlowExplorer(repository: FlowRepository = controlFlowRepository) {
  const [params, setParamsNow] = useSearchParams();
  // `setParams` changes with every address, so an effect that used it would read the flow again each
  // time a job is selected. Reading it through a ref keeps the effect to what really changes what is loaded.
  const setParamsRef = useRef(setParamsNow);
  useLayoutEffect(() => {
    setParamsRef.current = setParamsNow;
  });
  const setParams = useCallback<typeof setParamsNow>(
    (next, options) => setParamsRef.current(next, options),
    []
  );
  const serialized = params.toString();
  const urlState = useMemo(() => readFlowUrlState(new URLSearchParams(serialized)), [serialized]);
  const rootParam = urlState.root;
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  const token = useConnectionStore((state) => state.token);
  const connection = JSON.stringify([getBaseUrl(), token]);

  const [loaded, setLoaded] = useState<LoadedFlow | null>(null);
  const [loading, setLoading] = useState(Boolean(rootParam));
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<FlowFilter>('all');
  const [limits, setLimits] = useState({ root: '', limit: DEFAULT_FLOW_VIEW_NODES });
  const [reloads, setReloads] = useState(0);
  const wantedNode = useRef(urlState.node);
  useLayoutEffect(() => {
    wantedNode.current = urlState.node;
  });
  const limit = limits.root === rootParam ? limits.limit : DEFAULT_FLOW_VIEW_NODES;

  useEffect(() => {
    void baseUrl;
    void token;
    void reloads;
    // What is shown belongs to one flow on one connection; anything else is dropped at once.
    setLoaded((prev) => (prev?.root === rootParam && prev.connection === connection ? prev : null));
    setError(null);
    if (!rootParam) return setLoading(false);
    const controller = new AbortController();
    const target = captureServerRequestTarget();
    const current = () => !controller.signal.aborted && currentConnection() === connection;
    setLoading(true);
    void (async () => {
      try {
        const view = await repository.view(rootParam, limit, controller.signal);
        if (!current()) return;
        setLoaded((prev) => accept(prev, view, target, connection, wantedNode.current));
      } catch (caught) {
        if (!current()) return;
        const moved = isNotFound(caught)
          ? await containingFlow(repository, rootParam, controller.signal)
          : undefined;
        if (!current()) return;
        if (typeof moved === 'string') {
          // The address named a job inside a flow: show the flow, with that job selected.
          setParams(flowSearchParams({ root: moved, node: rootParam }), { replace: true });
          return;
        }
        setError(moved instanceof Error ? moved : toError(caught));
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [repository, rootParam, limit, reloads, baseUrl, token, connection, setParams]);

  const tree = loaded?.root === rootParam ? loaded.tree : null;
  const view = loaded?.root === rootParam ? loaded.view : null;

  // A node that is not in the flow, or an address left over from an older page, is dropped from it.
  useEffect(() => {
    const node = tree && urlState.node && !tree.byId.has(urlState.node) ? null : urlState.node;
    const canonical = flowSearchParams({ root: urlState.root, node }).toString();
    if (canonical !== serialized) setParams(canonical, { replace: true });
  }, [tree, urlState, serialized, setParams]);

  const selected =
    tree && view ? (tree.byId.get(urlState.node ?? '') ?? tree.byId.get(view.root) ?? null) : null;
  const rows: FlowRow[] = useMemo(
    () => (loaded && tree ? flowRows(tree, loaded.expanded, filter) : []),
    [loaded, tree, filter]
  );

  const setExpanded = useCallback(
    (next: (open: ReadonlySet<string>, tree: FlowTree) => Set<string>) => {
      setLoaded((prev) => (prev ? { ...prev, expanded: next(prev.expanded, prev.tree) } : prev));
    },
    []
  );
  const toggle = useCallback(
    (id: string) =>
      setExpanded((open) => {
        const next = new Set(open);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [setExpanded]
  );
  const showMore = useCallback(() => {
    const total = view?.total ?? MAX_FLOW_VIEW_NODES;
    setLimits({
      root: rootParam,
      limit: Math.min(MAX_FLOW_VIEW_NODES, Math.max(total, limit + 1)),
    });
  }, [rootParam, limit, view?.total]);

  return {
    root: rootParam,
    view,
    tree,
    flow: loaded?.root === rootParam ? loaded : null,
    rows,
    selected,
    loading,
    error,
    filter,
    setFilter,
    limit,
    canShowMore: Boolean(view?.truncated) && limit < MAX_FLOW_VIEW_NODES,
    showMore,
    toggle,
    expandAll: () => setExpanded((_, t) => allParents(t)),
    collapseAll: () => setExpanded(() => new Set()),
    select: (id: string) => setParams(flowSearchParams({ root: rootParam, node: id })),
    open: (root: string, node: string | null = null) => setParams(flowSearchParams({ root, node })),
    close: () => setParams(new URLSearchParams()),
    reload: () => setReloads((count) => count + 1),
  };
}

function accept(
  prev: LoadedFlow | null,
  view: FlowView,
  target: ServerRequestTarget,
  connection: string,
  node: string | null
): LoadedFlow {
  const tree = buildFlowTree(view.nodes);
  const keep = node !== null && tree.byId.has(node) ? node : null;
  const same = prev?.root === view.root && prev.connection === connection;
  const expanded = same
    ? reopenAfterReload(prev.expanded, prev.tree, tree, keep)
    : withWayTo(defaultExpanded(tree), tree, keep);
  return { root: view.root, connection, view, tree, target, expanded };
}

function withWayTo(open: Set<string>, tree: FlowTree, id: string | null): Set<string> {
  if (id !== null) for (const parent of ancestorsOf(tree, id)) open.add(parent);
  return open;
}

/** The flow of the job `id`, `undefined` when that cannot be told, or an error to show instead. */
async function containingFlow(
  repository: FlowRepository,
  id: string,
  signal: AbortSignal
): Promise<string | Error | undefined> {
  try {
    const root = await repository.rootOf(id, signal);
    if (root === null) return new Error(`Job ${id} is not part of a flow.`);
    return root === id ? undefined : root;
  } catch {
    return undefined;
  }
}

const toError = (caught: unknown): Error =>
  caught instanceof Error ? caught : new Error('Failed to load flow');

export function isFlowConnectionFailure(error: Error): boolean {
  return (
    (error instanceof BqError && error.status === 0) ||
    ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
  );
}
