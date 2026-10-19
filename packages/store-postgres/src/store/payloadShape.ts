/** What a payload may hold once decoded; the encoded size has its own cap (`maxPayloadBytes`). */
export interface ShapeLimits {
  /** Values and object keys together. */
  readonly maxPayloadNodes: number;
  readonly maxPayloadDepth: number;
}

/** Measured on msgpackr: up to 70 bytes of heap a node (empty objects and arrays), 8 for a scalar. 20,000 nodes is at most 1.4 MB. */
export const MAX_PAYLOAD_NODES = 20_000;
export const MAX_PAYLOAD_DEPTH = 64;

export interface ShapeViolation {
  readonly kind: 'nodes' | 'depth';
  readonly limit: number;
}

/** Containers the codec writes by value: one node, not walked. */
const isLeaf = (value: object) =>
  value instanceof Date ||
  value instanceof RegExp ||
  value instanceof Error ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value);

/**
 * The first limit `value` breaks, or null. An encoded payload decodes to many times its size (a
 * million `null`s is 1 MiB and about 19 MB), and the Control API decodes a page of them at once, so
 * the size cap alone does not bound it. Iterative, so a value nested a million deep cannot overflow
 * the stack, and it stops at the first violation, so a cycle ends at the node cap.
 */
export function overShape(value: unknown, limits: ShapeLimits): ShapeViolation | null {
  let nodes = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [item, depth] = top;
    if (++nodes > limits.maxPayloadNodes) return { kind: 'nodes', limit: limits.maxPayloadNodes };
    if (typeof item !== 'object' || item === null || isLeaf(item)) continue;
    if (depth > limits.maxPayloadDepth) return { kind: 'depth', limit: limits.maxPayloadDepth };
    if (item instanceof Map) {
      for (const [key, entry] of item) stack.push([key, depth + 1], [entry, depth + 1]);
    } else if (item instanceof Set || Array.isArray(item)) {
      for (const entry of item as Iterable<unknown>) stack.push([entry, depth + 1]);
    } else {
      for (const key of Object.keys(item)) {
        nodes += 1;
        stack.push([(item as Record<string, unknown>)[key], depth + 1]);
      }
    }
  }
  return null;
}
