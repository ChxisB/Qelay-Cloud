import { ICON } from '@/components/layout/NavIcon';

/** Glyphs for the tile of a node, as SVG paths on a 24 grid. A kind that is not listed gets `node`. */
const repeat = 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3';

export const NODE_ICON = {
  job: ICON.jobs,
  step: 'M8 5v14l11-7z',
  waitFor: ICON.cron,
  branch: ICON.flows,
  parallel: 'M5 6h14M5 12h14M5 18h14',
  subWorkflow: ICON.workflows,
  doUntil: repeat,
  doWhile: repeat,
  forEach: repeat,
  node: 'M5 5h14v14H5z',
} as const;

export const nodeIcon = (kind: string): string =>
  (NODE_ICON as Record<string, string>)[kind] ?? NODE_ICON.node;
