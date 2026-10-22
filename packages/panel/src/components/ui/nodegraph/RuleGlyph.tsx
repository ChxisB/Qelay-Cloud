import { cn } from '@/lib/cn';

// Path data from the design's icon set: a 24px grid, 2px stroke, round caps.
const RULE_ICON: Record<string, string> = {
  Filter: 'M3 5h18l-7 8v6l-4-2v-5z',
  Deduplicate: 'M9 9h10v10H9zM5 15V5h10',
  Shape:
    'M8 3c-2 0-3 1-3 3v3c0 1-1 3-3 3 2 0 3 2 3 3v3c0 2 1 3 3 3M16 3c2 0 3 1 3 3v3c0 1 1 3 3 3-2 0-3 2-3 3v3c0 2-1 3-3 3',
  Delay: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  Retry: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  'Rate limit': 'M4 17a8 8 0 1 1 16 0M12 17l4-5',
  'Auto-pause': 'M10 9v6M14 9v6M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
};

/** What the glyphs need from a rule: `ruleCards()` returns more than this. */
export interface RuleView {
  name: string;
  on: boolean;
  /** Set on this connection rather than the same for every connection. */
  editable: boolean;
  summary: string;
}

const TONE = {
  on: 'border-active text-active',
  off: 'border-dashed border-line-strong text-faint',
  fixed: 'border-line-strong text-fg',
};

/**
 * A rule as a round glyph: on is a ring and glyph in the line colour, off is a dashed ring and a faint glyph,
 * fixed is the same for every connection. Alone it is an image named for the rule; `decorative` hides it where the
 * rule's name is written beside it.
 */
export function RuleGlyph({
  name,
  tone,
  decorative = false,
  small = false,
}: {
  name: string;
  tone: keyof typeof TONE;
  decorative?: boolean;
  small?: boolean;
}) {
  return (
    <span
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name, title: name })}
      className={cn(
        'inline-grid flex-none place-items-center rounded-full border-[1.5px] bg-surface',
        small ? 'size-[22px]' : 'size-7',
        TONE[tone]
      )}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={small ? 'size-3' : 'size-[15px]'}
      >
        <path d={RULE_ICON[name] ?? RULE_ICON.Filter} />
      </svg>
    </span>
  );
}

/** The rules this connection set and left on, in the order an event meets them. Fixed rules and off ones are not drawn. */
export function RuleGlyphs({ rules }: { rules: readonly RuleView[] }) {
  return rules
    .filter((rule) => rule.editable && rule.on)
    .map((rule) => <RuleGlyph key={rule.name} name={rule.name} tone="on" />);
}
