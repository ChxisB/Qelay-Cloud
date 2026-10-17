import { ApiError } from '../errors';

/**
 * Counts the open event streams of one instance: each costs a socket and a journal read every
 * poll interval, so both a principal's share and the total are capped. A principal over its cap is
 * told so (429, it can close one of its own); the instance being full is 503 for everyone.
 */
export class StreamGate {
  private readonly byPrincipal = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxPerPrincipal: number,
    private readonly maxStreams: number
  ) {}

  /** Streams open now. */
  get open(): number {
    return this.total;
  }

  /** Takes a place for `principal`, or throws 429 or 503. The returned function gives it back, once. */
  acquire(principal: string): () => void {
    const held = this.byPrincipal.get(principal) ?? 0;
    if (held >= this.maxPerPrincipal) {
      throw new ApiError(
        429,
        'too_many_streams',
        'this principal has too many open event streams; close one first',
        { max: this.maxPerPrincipal },
        { 'retry-after': '5' }
      );
    }
    if (this.total >= this.maxStreams) {
      throw new ApiError(
        503,
        'streams_unavailable',
        'this instance has no room for another event stream; try again shortly',
        { max: this.maxStreams },
        { 'retry-after': '5' }
      );
    }
    this.byPrincipal.set(principal, held + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.byPrincipal.get(principal) ?? 1) - 1;
      if (left <= 0) this.byPrincipal.delete(principal);
      else this.byPrincipal.set(principal, left);
    };
  }
}
