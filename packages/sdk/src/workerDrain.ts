export interface DrainOptions {
  /** How long the worker stays idle before the queue is checked. */
  readonly afterMs: number;
  /** True while the worker has no job, no claim out and is not closing. */
  readonly idle: () => boolean;
  /** Jobs the queue holds that a worker could take now. */
  readonly pending: () => Promise<number>;
  readonly emit: () => void;
}

/**
 * `drained`: the worker has been idle for `afterMs` and the queue has nothing waiting. One check
 * per idle spell, not one per job, and none while a job runs. A failed check only means no
 * `drained` this time; the next idle spell checks again.
 */
export class DrainWatch {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #emitted = false;

  constructor(private readonly options: DrainOptions) {}

  /** A job started: the next idle spell may emit again. */
  work(): void {
    this.#emitted = false;
    this.cancel();
  }

  /** The worker may have gone idle: check after the quiet period unless one is already due. */
  arm(): void {
    if (this.#timer !== null || this.#emitted || !this.options.idle()) return;
    this.#timer = setTimeout(() => void this.#check(), this.options.afterMs);
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #check(): Promise<void> {
    this.#timer = null;
    if (!this.options.idle()) return;
    try {
      const pending = await this.options.pending();
      if (pending === 0 && this.options.idle() && !this.#emitted) {
        this.#emitted = true;
        this.options.emit();
      }
    } catch {
      // See the class comment.
    }
  }
}
