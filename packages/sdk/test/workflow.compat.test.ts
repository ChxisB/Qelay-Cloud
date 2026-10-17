import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, Workflow } from '../src';

/**
 * The public names of Qelay's workflow `Engine`, `Workflow` and `EngineOptions` (upstream commit
 * c43442c9, `src/client/workflow/`), listed here because `../qelay` is not available to CI.
 * docs/compat.md must classify each one.
 */
const UPSTREAM_ENGINE =
  `constructor register start getExecution resumeCompensation abandonCompensation signal recover
on onAny off offAny subscribe cleanup archive getArchivedCount close`.split(/\s+/);
const UPSTREAM_WORKFLOW =
  `constructor seal step branch path parallel subWorkflow waitFor doUntil doWhile forEach map
pivot getIndexedStepNames getStepNames`.split(/\s+/);
const UPSTREAM_OPTIONS = 'embedded dataPath connection queueName concurrency onEvent'.split(' ');
/** The process-global clock upstream exported, which the `clock` option of the engine replaces. */
const UPSTREAM_OTHER = 'setClock resetClock simulatedClock WorkflowStore'.split(' ');

/** Helpers of the classes that are not part of their API. */
const INTERNAL = new Set(['assertMutable']);

const doc = readFileSync(join(import.meta.dir, '../../../docs/compat.md'), 'utf8');

/** The text of the workflow section. */
function workflowSection(): string {
  const start = doc.indexOf('\n## Workflow engine\n');
  const end = doc.indexOf('\n## ', start + 1);
  return start < 0 ? '' : doc.slice(start, end < 0 ? undefined : end);
}

function mentioned(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
}

function methodsOf(cls: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(cls.prototype).filter(
    (key) =>
      typeof Object.getOwnPropertyDescriptor(cls.prototype, key)?.value === 'function' &&
      !INTERNAL.has(key)
  );
}

describe('docs/compat.md, workflow engine', () => {
  const text = workflowSection();

  test('has the section', () => {
    expect(text).not.toBe('');
  });

  test('the upstream lists have no duplicates', () => {
    for (const list of [UPSTREAM_ENGINE, UPSTREAM_WORKFLOW, UPSTREAM_OPTIONS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test('classifies every public name of Qelay’s Engine, Workflow and EngineOptions', () => {
    const names = [
      ...UPSTREAM_ENGINE,
      ...UPSTREAM_WORKFLOW,
      ...UPSTREAM_OPTIONS,
      ...UPSTREAM_OTHER,
    ];
    expect(names.filter((name) => !mentioned(text, name))).toEqual([]);
  });

  test('classifies every method this Engine and Workflow have', () => {
    const names = [...methodsOf(Engine), ...methodsOf(Workflow)];
    expect(names.filter((name) => !mentioned(text, name))).toEqual([]);
  });

  test('says which methods are new', () => {
    for (const name of ['startWorkflow', 'cancel', 'listExecutions', 'defineWorkflow']) {
      expect(new RegExp(`\`${name}[^\\n]*\\| New \\|`).test(text)).toBe(true);
    }
  });
});
