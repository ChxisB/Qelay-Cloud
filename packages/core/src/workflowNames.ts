/**
 * How the engine names the step records of a loop. Shared by the engine, which writes them, and by
 * the operator surface, which groups them back under the step they belong to.
 */

/**
 * A loop iteration record is `<step>:<digits>` and nothing else.
 *
 * Three separate defects came from treating "contains a colon" as the test: a step
 * legitimately named `charge:extra` was resolved to a loop body called `charge`, was
 * dropped from the unwind set, and had its compensate context rebound to another
 * step's result. A colon is a legal character in a user-chosen step name; only the
 * numeric suffix this engine appends is structural.
 */
export const LOOP_ITERATION_SUFFIX = /:\d+$/;

/**
 * What is left of an iteration record once its base name is removed: `:` then digits
 * and NOTHING else.
 *
 * Anchoring at both ends is the whole point. Testing the unanchored
 * `LOOP_ITERATION_SUFFIX` against the remainder only checks that the name ENDS in a
 * numeric segment, so a loop body whose own name contains a colon collides with a
 * shorter one: `charge:extra:1` matched base `charge`, leaving remainder `:extra:1`,
 * which ends in `:1`. `findStepDef` then handed every `charge:extra` iteration the
 * `charge` handler — `charge`'s reversal ran twice per iteration, `charge:extra`'s
 * never ran, and the run still reported `rollbackStatus: 'completed'`.
 */
const EXACT_ITERATION_REMAINDER = /^:\d+$/;

/** Is `name` an iteration record of the loop body step `base`? */
export function isIterationOf(name: string, base: string): boolean {
  return name.startsWith(`${base}:`) && EXACT_ITERATION_REMAINDER.test(name.slice(base.length));
}

/** `charge:2` -> `charge`; `charge:extra` -> `charge:extra` (not an iteration). */
export function loopBaseName(name: string): string {
  return LOOP_ITERATION_SUFFIX.test(name) ? name.replace(LOOP_ITERATION_SUFFIX, '') : name;
}
