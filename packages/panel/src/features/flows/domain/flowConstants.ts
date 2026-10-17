/** Height of one line of the tree, in pixels: the tree draws only the lines in view, so it is fixed. */
export const FLOW_ROW_HEIGHT = 40;
/** Lines drawn above and below what is in view, so a quick scroll does not show a gap. */
export const FLOW_ROW_OVERSCAN = 8;
/** Flows listed per page. */
export const FLOW_PAGE_SIZE = 25;
/** The deepest a line is indented, in levels: deeper jobs line up with it. */
export const FLOW_MAX_INDENT = 24;
export const FLOW_INDENT_PX = 16;

// Chrome per state, on the job-state tokens (index.css). `waiting-children` reads as waiting; the
// dashed border keeps it distinguishable from a plain waiting job.
const STATE_STYLE: Record<string, string> = {
  completed: 'border-state-completed-fg/50 bg-state-completed-bg text-state-completed-fg',
  failed: 'border-state-failed-fg/50 bg-state-failed-bg text-state-failed-fg',
  active: 'border-state-active-fg/50 bg-state-active-bg text-state-active-fg',
  delayed: 'border-state-delayed-fg/50 bg-state-delayed-bg text-state-delayed-fg',
  waiting: 'border-state-waiting-fg/50 bg-state-waiting-bg text-state-waiting-fg',
  prioritized: 'border-state-prioritized-fg/50 bg-state-prioritized-bg text-state-prioritized-fg',
  'waiting-children':
    'border-dashed border-state-waiting-fg/60 bg-state-waiting-bg text-state-waiting-fg',
};

export const flowStateStyle = (state?: string) =>
  (state && STATE_STYLE[state]) || 'border-line bg-surface-2 text-muted';

export const shortFlowId = (id: string) =>
  id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
