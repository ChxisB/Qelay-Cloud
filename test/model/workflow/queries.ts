import fc from 'fast-check';
import { IDS, NAMES, Op, STATES } from './op';

/** Reads: what the listings and lookups answer must match too, whatever the history has done. */
export const QUERIES: Array<fc.Arbitrary<Op>> = [
  fc
    .tuple(
      fc.option(fc.constantFrom(...NAMES), { nil: undefined }),
      fc.option(fc.constantFrom(...STATES), { nil: undefined }),
      fc.constantFrom(1, 2, 100),
      fc.constantFrom(0, 1)
    )
    .map(
      ([name, state, limit, offset]) =>
        new Op(
          `list(${name ?? 'any'}, ${state ?? 'any'}, limit ${limit}, offset ${offset})`,
          (store) => store.list(name, state, { limit, offset })
        )
    ),
  fc
    .constantFrom(...NAMES)
    .map((name) => new Op(`listActive(${name})`, (store) => store.listActive(name))),
  fc.tuple(fc.constantFrom(1, 2, 100), fc.constantFrom(0, 500, 5000)).map(
    ([limit, idleMs]) =>
      new Op(
        `listRecoverable(limit ${limit}, idle ${idleMs} ms)`,
        (store) => store.listRecoverable({ limit, idleMs }),
        (outcome) =>
          outcome.ok && (outcome.value as unknown[]).length > 0 ? 'recoverable.some' : undefined
      )
  ),
  fc.tuple(fc.constantFrom(...IDS), fc.constantFrom(...NAMES)).map(
    ([parent, name]) =>
      new Op(
        `findChild(${parent}, ${name})`,
        (store) => store.findChild(parent, name),
        (outcome) => (outcome.ok && outcome.value ? 'child.found' : undefined)
      )
  ),
];
