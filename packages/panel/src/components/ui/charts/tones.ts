export type Tone = 'ok' | 'bad' | 'warn' | 'active' | 'idle' | 'rose' | 'hl';

/** Solid fill per tone, for meters and bars that carry their value as text beside them. */
export const SOLID: Record<Tone, string> = {
  ok: 'bg-ok',
  bad: 'bg-bad',
  warn: 'bg-warn',
  active: 'bg-active',
  idle: 'bg-idle',
  rose: 'bg-rose',
  hl: 'bg-hl',
};

/** Fill for a chart mark: `bad` is striped, so a failure is never told by red alone. */
export const FILL: Record<Tone, string> = { ...SOLID, bad: 'hatch-bad' };

export const STROKE: Record<Tone, string> = {
  ok: 'stroke-ok',
  bad: 'stroke-bad',
  warn: 'stroke-warn',
  active: 'stroke-active',
  idle: 'stroke-idle',
  rose: 'stroke-rose',
  hl: 'stroke-hl',
};

export const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
