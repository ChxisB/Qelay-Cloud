import { EventEmitter } from 'node:events';

type Listeners<L> = { [K in keyof L]: (...args: never[]) => void };

/** `on`, `once` and `off` that take the event names of `L` and check each listener against its signature. */
interface Typed<L extends Listeners<L>> {
  on<E extends keyof L & string>(event: E, listener: L[E]): this;
  once<E extends keyof L & string>(event: E, listener: L[E]): this;
  off<E extends keyof L & string>(event: E, listener: L[E]): this;
}

/** An `EventEmitter` typed by the listeners of `L`: `class Worker extends TypedEmitter<WorkerEvents>`. */
export const TypedEmitter: new <L extends Listeners<L>>() => Typed<L> &
  Omit<EventEmitter, 'on' | 'once' | 'off'> = EventEmitter as never;

/**
 * Calls the listeners of `event` one by one, each on its own: `EventEmitter.emit` stops at the first
 * listener that throws and the ones after it never hear the event, so a bug in one subscriber would
 * silence the others. A throw goes to `onThrow` and the rest still run. `once` listeners are honoured.
 */
export function emitIsolated(
  emitter: EventEmitter,
  event: string,
  args: readonly unknown[],
  onThrow: (error: unknown) => void
): void {
  for (const listener of emitter.rawListeners(event)) {
    try {
      Reflect.apply(listener, emitter, args);
    } catch (error) {
      onThrow(error);
    }
  }
}
