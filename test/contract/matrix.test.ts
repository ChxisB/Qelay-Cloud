import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  BEGIN,
  declaredCapabilities,
  DELAY_FIGURES,
  END,
  renderTransportsDoc,
} from '../../scripts/transportsDoc';
import { COLUMNS, EVIDENCE, MATRIX } from '../../scripts/transportsDocMatrix';
import { allScenarios } from '../scenarios/all';
import { CONTRACT_SKIPS } from './skips';

const ROOT = resolve(import.meta.dir, '../..');
const read = (path: string) => Bun.file(resolve(ROOT, path)).text();

function block(doc: string, name: string): string {
  const start = doc.indexOf(BEGIN(name));
  const end = doc.indexOf(END(name));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start + BEGIN(name).length, end).trim();
}

/** Markdown without emphasis and with one space between words, so a figure compares across files. */
const plain = (text: string) => text.replace(/\*/g, '').replace(/\s+/g, ' ');

/** The part of limits.md between "## 1." and "## 2.". */
function delaySection(limits: string): string {
  const start = limits.indexOf('## 1. Delay precision');
  const end = limits.indexOf('## 2. Sizes and counts');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return limits.slice(start, end);
}

describe('docs/transports.md', () => {
  test('is the document the generator renders: `bun run docs:transports` after a change', async () => {
    expect(await read('docs/transports.md')).toBe(await renderTransportsDoc());
  });

  test('prints what each transport declares, read back from the file against the live objects', async () => {
    const declared = await declaredCapabilities();
    const rows = block(await read('docs/transports.md'), 'capabilities')
      .split('\n')
      .slice(2)
      .map((line) =>
        line
          .split('|')
          .slice(2, -1)
          .map((cell) => cell.trim())
      );
    const number = (cell: string) =>
      cell.startsWith('unbounded')
        ? Number.POSITIVE_INFINITY
        : Number(cell.replace(/[, ]/g, '').match(/^\d+/)![0]);
    expect(rows).toHaveLength(4);
    COLUMNS.forEach((column, index) => {
      const [delay, batch, attempt, retry] = rows.map((row) => row[index]!);
      expect(number(delay!)).toBe(declared[column].maxDeliverDelayMs);
      expect(number(batch!)).toBe(declared[column].maxRingBatch);
      expect(attempt).toBe(`\`${declared[column].attemptCount}\``);
      expect(number(retry!)).toBe(declared[column].retryGranularityMs);
    });
  });

  test('every delay figure is the one in docs/limits.md section 1', async () => {
    const limits = plain(delaySection(await read('docs/limits.md')));
    const transports = plain(block(await read('docs/transports.md'), 'delay'));
    for (const [, figure] of DELAY_FIGURES) {
      expect(limits).toContain(figure);
      expect(transports).toContain(figure);
    }
    // The SQS window is the declared one, in the same unit limits.md states it.
    const declared = await declaredCapabilities();
    expect(limits).toContain(`${declared['aws-sqs'].maxDeliverDelayMs / 1000} s`);
  });

  test('every cell of the matrix says whether it is emulator, tested, design or not run', () => {
    for (const [label, ...cells] of MATRIX) {
      expect(cells).toHaveLength(COLUMNS.length);
      for (const cell of cells) {
        const labelled = EVIDENCE.some((evidence) => cell.includes(evidence));
        expect(labelled, `${label}: ${cell}`).toBe(true);
      }
    }
  });

  test('lists every skipped contract behaviour and scenario with its reason', async () => {
    const doc = await read('docs/transports.md');
    const skips = block(doc, 'skips');
    for (const [transport, behaviours] of Object.entries(CONTRACT_SKIPS)) {
      for (const [behaviour, reason] of Object.entries(behaviours)) {
        expect(reason).not.toBe('');
        expect(skips).toContain(`\`${transport}\` | \`${behaviour}\` | ${reason}`);
      }
    }
    for (const scenario of allScenarios) {
      for (const [stack, reason] of Object.entries(scenario.skip ?? {})) {
        expect(reason).not.toBe('');
        expect(skips).toContain(`Scenario: ${scenario.name} | \`${stack}\``);
      }
    }
  });

  test('says SQS granularity (D2) was not measured, and that the real clouds were not run', async () => {
    const doc = await read('docs/transports.md');
    expect(doc).toContain('SQS: not measured; per job by default');
    expect(doc).toContain('QCLOUD_REAL_CLOUD=1');
    expect(doc).toContain('Real SQS: not measured');
  });

  test('has an emulator-only row for each known gap', async () => {
    const emulator = block(await read('docs/transports.md'), 'emulator');
    for (const gap of ['retry backoff', 'receive counts', 'stale receipt handles', 'Failed[]']) {
      expect(emulator).toContain(gap);
    }
  });
});
