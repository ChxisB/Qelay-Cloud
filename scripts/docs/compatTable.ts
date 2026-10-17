/**
 * Reads the tables of `docs/compat.md` that have a Status column, so the list of what is not supported is made from
 * the table and cannot drift from it. `packages/sdk/test/queue.compat.test.ts` keeps the table complete.
 */
import { parseMarkdown } from './markdown';

export const STATUSES = ['Supported', 'Differs', 'New', 'Not supported'] as const;
export type Status = (typeof STATUSES)[number];

export interface CompatRow {
  /** The nearest `##` heading's text, and the nearest heading's anchor. */
  readonly section: string;
  readonly sectionAnchor: string;
  readonly heading: string;
  readonly anchor: string;
  readonly feature: string;
  readonly status: Status;
  /** The detail after the status word (`(D6)`, `, with the bounds ...`) and the notes column, joined. */
  readonly note: string;
}

/** Splits a table row on `|`, keeping `\|` and anything inside backticks. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '`') {
      code = !code;
      cell += ch;
    } else if (ch === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  // A row starts and ends with a pipe: drop the empty cells outside them.
  return cells.slice(1, line.trimEnd().endsWith('|') ? -1 : undefined);
}

export function statusOf(cell: string): Status | null {
  for (const status of STATUSES) if (cell.startsWith(status)) return status;
  return null;
}

export function compatRows(text: string): CompatRow[] {
  const doc = parseMarkdown('docs/compat.md', text);
  const rows: CompatRow[] = [];
  const lines = text.split('\n');
  const fenced = new Set<number>();
  for (const fence of doc.fences) {
    const size = fence.body === '' ? 0 : fence.body.split('\n').length;
    for (let line = fence.line; line <= fence.line + size + 1; line++) fenced.add(line);
  }
  let inStatusTable = false;
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (fenced.has(number) || !line.startsWith('|')) {
      inStatusTable = false;
      continue;
    }
    const cells = splitRow(line);
    if (/^[\s:|-]+$/u.test(line)) continue;
    if (cells[1] === 'Status') {
      inStatusTable = true;
      continue;
    }
    if (!inStatusTable) continue;
    const status = statusOf(cells[1] ?? '');
    if (status === null) continue;
    const heading = [...doc.headings].reverse().find((h) => h.line < number);
    const section = [...doc.headings].reverse().find((h) => h.line < number && h.level === 2);
    const detail = (cells[1] ?? '').slice(status.length).replace(/^[\s,.:]+/u, '');
    rows.push({
      section: section?.text ?? '',
      sectionAnchor: section?.slug ?? '',
      heading: heading?.text ?? '',
      anchor: heading?.slug ?? '',
      feature: cells[0] ?? '',
      status,
      note: [detail, cells[2] ?? ''].filter((part) => part !== '').join(' '),
    });
  }
  return rows;
}
