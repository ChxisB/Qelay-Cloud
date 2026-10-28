import type { SQL } from 'bun';
import type { Database } from '../src/connection/connect';

export interface Counted {
  readonly db: Database;
  /** Statements run on the database since the last `reset`. */
  count(): number;
  reset(): void;
}

/**
 * A database that counts the statements its operations run: every tagged-template query and every `unsafe` on a
 * connection, and on the transactions opened from it. Helpers such as `tx.array` are not statements and are not counted.
 */
export function countStatements(db: Database): Counted {
  let statements = 0;
  const wrap = (target: SQL): SQL =>
    new Proxy(target, {
      apply(fn, self, args) {
        statements += 1;
        return Reflect.apply(fn as unknown as (...a: unknown[]) => unknown, self, args);
      },
      get(object, property) {
        const value = Reflect.get(object, property) as unknown;
        if (typeof value !== 'function') return value;
        const method = value as (...a: unknown[]) => unknown;
        if (property === 'unsafe') {
          return (...args: unknown[]) => {
            statements += 1;
            return method.apply(object, args);
          };
        }
        if (property === 'begin') {
          return (...args: unknown[]) =>
            method.apply(
              object,
              args.map((arg) =>
                typeof arg === 'function'
                  ? (tx: SQL) => (arg as (t: SQL) => unknown)(wrap(tx))
                  : arg
              )
            );
        }
        return method.bind(object);
      },
    });
  const counted = Object.create(db, {
    run: {
      value: <T>(operation: string, work: (sql: SQL) => Promise<T>, deadlineMs?: number) =>
        db.run(operation, (sql) => work(wrap(sql)), deadlineMs),
    },
  }) as Database;
  return {
    db: counted,
    count: () => statements,
    reset: () => {
      statements = 0;
    },
  };
}
