/**
 * A small Markdown reader for `docs:check`: the headings (and the anchors GitHub makes from them), the links, and the
 * fenced code blocks of one file. It is not a Markdown implementation: it knows exactly what the checks need.
 */
import { readFileSync } from 'node:fs';

export interface Heading {
  readonly level: number;
  readonly text: string;
  readonly slug: string;
  readonly line: number;
}

export interface Link {
  readonly target: string;
  readonly line: number;
}

export interface Fence {
  /** The first word of the info string: `bash`, `ts`, `yaml`, or empty. */
  readonly lang: string;
  /** The words after it: `test`, `notrun`. */
  readonly flags: readonly string[];
  readonly body: string;
  /** The line of the opening fence, 1-based. */
  readonly line: number;
  /** The nearest heading above, for messages. */
  readonly heading: string | null;
  /** The text of a `> Not run: ...` quote between the previous heading and this fence, or null. */
  readonly notRun: string | null;
}

export interface MarkdownDoc {
  readonly path: string;
  readonly headings: readonly Heading[];
  /** Every anchor a link may name: heading slugs and explicit `id`/`name` attributes. */
  readonly anchors: ReadonlySet<string>;
  readonly links: readonly Link[];
  readonly fences: readonly Fence[];
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/u;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;
const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/u;
const HTML_ID = /\b(?:id|name)="([^"]+)"/gu;

/** The anchor GitHub gives a heading: its rendered text, lowercased, without punctuation, spaces to hyphens. */
export function slugOf(headingText: string): string {
  return headingText
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, '')
    .replace(/[`*]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/gu, '-');
}

/** Blanks out inline code, so a bracket pair inside backticks is not read as a link. */
function withoutInlineCode(line: string): string {
  return line.replace(/(`+)(?:(?!\1).)+?\1/gu, (span) => ' '.repeat(span.length));
}

function unwrap(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

export function parseMarkdown(path: string, text: string): MarkdownDoc {
  const headings: Heading[] = [];
  const links: Link[] = [];
  const fences: Fence[] = [];
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let open: { marker: string; lang: string; flags: string[]; line: number; body: string[] } | null =
    null;
  let heading: string | null = null;
  let quote: string | null = null;

  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (open !== null) {
      const closing = new RegExp(`^ {0,3}${open.marker[0]}{${open.marker.length},}\\s*$`, 'u');
      if (closing.test(raw)) {
        fences.push({
          lang: open.lang,
          flags: open.flags,
          body: open.body.join('\n'),
          line: open.line,
          heading,
          notRun: quote,
        });
        open = null;
      } else {
        open.body.push(raw);
      }
      continue;
    }
    const fence = OPEN_FENCE.exec(raw);
    if (fence !== null) {
      const [lang = '', ...flags] = fence[2]!.trim().split(/\s+/u).filter(Boolean);
      open = { marker: fence[1]!, lang, flags, line, body: [] };
      continue;
    }
    const head = HEADING.exec(raw);
    if (head !== null) {
      const slug = slugOf(head[2]!);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      const unique = count === 0 ? slug : `${slug}-${count}`;
      headings.push({ level: head[1]!.length, text: head[2]!, slug: unique, line });
      anchors.add(unique);
      heading = head[2]!;
      quote = null;
    }
    const noted = /^\s*>\s*Not run\b:?\s*(.*)$/u.exec(raw);
    if (noted !== null) quote = noted[1] || 'not run';
    for (const match of raw.matchAll(HTML_ID)) anchors.add(match[1]!);

    const prose = withoutInlineCode(raw);
    for (const match of prose.matchAll(INLINE_LINK)) {
      links.push({ target: unwrap(match[1]!), line });
    }
    const definition = DEFINITION.exec(prose);
    if (definition !== null) links.push({ target: unwrap(definition[1]!), line });
  }
  return { path, headings, anchors, links, fences };
}

export function readMarkdown(path: string): MarkdownDoc {
  return parseMarkdown(path, readFileSync(path, 'utf8'));
}
