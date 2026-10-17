/**
 * The documents `docs:check` writes (`bun run docs:check --write`) and checks are current. Each is made from a source
 * that a test already keeps true, so a change there changes the document and the check fails until it is written.
 */
import { resolve } from 'node:path';
import { compatRows, STATUSES } from './compatTable';
import type { CompatRow, Status } from './compatTable';
import { ROOT } from './links';
import { renderSdkExports } from './sdkExports';

const NOTICE = (source: string) =>
  `> Generated from ${source} by \`bun run docs:check --write\`. Do not edit it by hand: change the source.`;

/** A relative link in a copied note pointed into compat.md; from another file it has to say so. */
const fromCompat = (text: string) => text.replace(/\]\(#/gu, '](compat.md#');
/** A table cell cannot hold a bare pipe. */
const cell = (text: string) => text.replace(/\|/gu, '\\|');

export function renderUnsupported(compat: string): string {
  const rows = compatRows(compat);
  const sections = [...new Set(rows.map((row) => row.section))];
  const count = (section: string, status: Status) =>
    rows.filter((row) => row.section === section && row.status === status).length;
  const anchorOf = (section: string) => rows.find((row) => row.section === section)!.sectionAnchor;

  const out: string[] = [
    '# What is not in Qelay-Cloud',
    '',
    NOTICE('[compat.md](compat.md)'),
    '',
    'Qelay-Cloud covers the BullMQ-style core of Qelay (decision D6) on managed queues. Each entry below either throws',
    '`UnsupportedOptionError` naming the option, answers `501 not_supported` from the Control API, or is a method that does',
    'not exist on the class. **Nothing is ignored silently.** [Moving from Qelay](migration.md) says what to change first.',
    '',
    '## At a glance',
    '',
    `| Part of the API | ${STATUSES.join(' | ')} |`,
    `| --- | ${STATUSES.map(() => '---:').join(' | ')} |`,
    ...sections.map(
      (section) =>
        `| [${cell(section)}](compat.md#${anchorOf(section)}) | ${STATUSES.map((status) => count(section, status)).join(' | ')} |`
    ),
    `| **All** | ${STATUSES.map((status) => rows.filter((row) => row.status === status).length).join(' | ')} |`,
    '',
    'Supported: same name, arguments and result. Differs: same name, and compat.md states the difference. New: exists here',
    'and not upstream. Not supported: listed below.',
  ];
  for (const section of sections) {
    const missing: CompatRow[] = rows.filter(
      (row) => row.section === section && row.status === 'Not supported'
    );
    if (missing.length === 0) continue;
    out.push('', `## ${section}`, '', `Table: [compat.md](compat.md#${anchorOf(section)}).`, '');
    out.push('| Feature | Why, and what to do instead |', '| --- | --- |');
    for (const row of missing) {
      out.push(`| ${cell(row.feature)} | ${cell(fromCompat(row.note))} |`);
    }
  }
  return `${out.join('\n')}\n`;
}

interface Operation {
  readonly summary?: string;
  readonly tags?: string[];
}

export function renderRoutes(spec: string): string {
  const parsed = Bun.YAML.parse(spec) as {
    tags: Array<{ name: string; description?: string }>;
    paths: Record<string, Record<string, Operation>>;
  };
  const operations = Object.entries(parsed.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path,
      summary: operation.summary ?? '',
      tag: operation.tags?.[0] ?? 'other',
    }))
  );
  const out: string[] = [
    '# Control API routes',
    '',
    NOTICE('[openapi.yaml](../openapi.yaml)'),
    '',
    `${operations.length} operations. The schemas, parameters and every response are in [openapi.yaml](../openapi.yaml); a test`,
    'fails when a served route is missing from it or the other way round. `GET /health` takes no token; every other route',
    'takes a bearer token, and a route that changes something needs the `operator` role.',
  ];
  for (const { name, description } of parsed.tags) {
    const group = operations.filter((operation) => operation.tag === name);
    if (group.length === 0) continue;
    out.push('', `## ${name}`, '');
    if (description !== undefined) out.push(description.trim(), '');
    out.push('| Method | Path | What it does |', '| --- | --- | --- |');
    for (const operation of group) {
      out.push(
        `| ${operation.method} | \`${operation.path}\` | ${cell(operation.summary.replace(/\n/gu, ' '))} |`
      );
    }
  }
  return `${out.join('\n')}\n`;
}

export interface GeneratedDoc {
  /** Relative to the repository root. */
  readonly path: string;
  readonly render: () => Promise<string>;
}

const read = (path: string) => Bun.file(resolve(ROOT, path)).text();

export const GENERATED: readonly GeneratedDoc[] = [
  { path: 'docs/unsupported.md', render: async () => renderUnsupported(await read('docs/compat.md')) },
  { path: 'docs/reference/routes.md', render: async () => renderRoutes(await read('docs/openapi.yaml')) },
  { path: 'docs/reference/sdk-exports.md', render: renderSdkExports },
];
