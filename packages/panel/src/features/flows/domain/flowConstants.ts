/** Height of one line of the tree, in pixels: the tree draws only the lines in view, so it is fixed. */
export const FLOW_ROW_HEIGHT = 40;
/** Lines drawn above and below what is in view, so a quick scroll does not show a gap. */
export const FLOW_ROW_OVERSCAN = 8;
/** Flows listed per page. */
export const FLOW_PAGE_SIZE = 25;
/** The deepest a line is indented, in levels: deeper jobs line up with it. */
export const FLOW_MAX_INDENT = 24;
export const FLOW_INDENT_PX = 16;

export const shortFlowId = (id: string) =>
  id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

/**
 * The graph's cell (a square tile and the words under it), the tile's edge and the space between cells, in
 * pixels. The tile is centred in the cell, and the lines run from tile to tile.
 */
export const GRAPH_NODE_WIDTH = 160;
export const GRAPH_NODE_HEIGHT = 144;
export const GRAPH_TILE = 72;
export const GRAPH_COLUMN_GAP = 8;
export const GRAPH_ROW_GAP = 8;
/** A flow with more open jobs than this is shown as the list: a drawing of thousands of boxes helps nobody. */
export const GRAPH_NODE_LIMIT = 300;
