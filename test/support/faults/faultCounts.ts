/** How often each fault fired: the evidence a test asserts on, so a fault that never happened is visible. */
export interface FaultCounts {
  /** Ring calls forwarded to the wrapped transport, and those made to throw. */
  forwarded: number;
  thrown: number;
  dropped: number;
  duplicated: number;
  late: number;
  reordered: number;
  /** Items answered with a failure by `failItems` instead of being forwarded. */
  itemsFailed: number;
  acksDropped: number;
  deliveriesDuplicated: number;
  deliveriesDelayed: number;
  deliveriesReordered: number;
}

export function newFaultCounts(): FaultCounts {
  return {
    forwarded: 0,
    thrown: 0,
    dropped: 0,
    duplicated: 0,
    late: 0,
    reordered: 0,
    itemsFailed: 0,
    acksDropped: 0,
    deliveriesDuplicated: 0,
    deliveriesDelayed: 0,
    deliveriesReordered: 0,
  };
}
