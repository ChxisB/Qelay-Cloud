/**
 * `docs/reference/sdk-exports.md`: every name the SDK exports, its kind, where it is defined and the first paragraph of its
 * TSDoc, read by the TypeScript compiler from `packages/sdk/src/index.ts`. A new export appears here by itself.
 */
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { ROOT } from './links';

const ENTRY = 'packages/sdk/src/index.ts';

function kindOf(flags: ts.SymbolFlags): string {
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Variable) return 'constant';
  return 'other';
}

/** The first paragraph of a TSDoc comment, on one line, without a table-breaking pipe. */
function summaryOf(parts: readonly ts.SymbolDisplayPart[]): string {
  const text = ts.displayPartsToString([...parts]);
  const paragraph = text.split(/\n\s*\n/u)[0] ?? '';
  return paragraph.replace(/\s+/gu, ' ').trim().replace(/\|/gu, '\\|');
}

export interface ExportRow {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly summary: string;
}

export function sdkExports(): ExportRow[] {
  const program = ts.createProgram([resolve(ROOT, ENTRY)], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(resolve(ROOT, ENTRY));
  const moduleSymbol = entry === undefined ? undefined : checker.getSymbolAtLocation(entry);
  if (moduleSymbol === undefined) throw new Error(`cannot read the exports of ${ENTRY}`);
  const rows: ExportRow[] = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = symbol.declarations?.[0];
    rows.push({
      name: exported.name,
      kind: kindOf(symbol.flags),
      file: declaration === undefined ? '' : relative(ROOT, declaration.getSourceFile().fileName),
      summary: summaryOf(symbol.getDocumentationComment(checker)),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export async function renderSdkExports(): Promise<string> {
  const rows = sdkExports();
  const out = [
    '# SDK exports',
    '',
    '> Generated from the TSDoc of [packages/sdk/src/index.ts](../../packages/sdk/src/index.ts) by `bun run docs:check --write`.',
    '> Do not edit it by hand: change the source.',
    '',
    `The ${rows.length} names \`import ... from 'qelay-cloud'\` gives you. What each \`Queue\`, \`Worker\`, \`QueueEvents\` and`,
    '`FlowProducer` method does, and how it differs from Qelay, is in [compat.md](../compat.md); the workflow engine is its',
    'last section. A name with no summary has no TSDoc on its declaration: read the signature in the file named.',
    '',
    '| Name | Kind | Defined in | Summary |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.name}\` | ${row.kind} | [${row.file}](../../${row.file}) | ${row.summary === '' ? '' : row.summary} |`
    ),
  ];
  return `${out.join('\n')}\n`;
}
