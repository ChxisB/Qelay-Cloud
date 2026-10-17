/** Prints the connection-budget table that docs/spikes/05-db-access-and-delay.md quotes. */
import { budget, rdsMaxConnections } from '../packages/store-postgres/src/connection/budget';

const rows = [10, 50, 200].map((workers) => ({
  workers,
  pool2: budget({ workers }),
  pool5: budget({ workers, poolSize: 5 }),
  pool10: budget({ workers, poolSize: 10 }),
  events: budget({ workers, listeners: Math.ceil(workers / 10) }),
}));
console.log(
  'workers | pool=2 direct | pool=5 direct | pool=10 direct | pool=2 + 1/10 listening | pooled (20)'
);
for (const row of rows) {
  console.log(
    `${row.workers} | ${row.pool2.direct} | ${row.pool5.direct} | ${row.pool10.direct} | ${row.events.direct} | ${row.pool2.pooled}`
  );
}
for (const gib of [1, 2, 4, 8, 16, 64])
  console.log(`RDS ${gib} GiB nominal: <= ${rdsMaxConnections(gib)}`);
