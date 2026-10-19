/**
 * The hand-written half of `docs/transports.md`: what a broker does that no capability flag says.
 * Each cell carries its evidence, one of `declared` (read from the code), `emulator` (a test
 * against the Pub/Sub emulator or ElasticMQ), `tested` (a test against real Postgres or in
 * process), `design` (reasoned, not run) or `not run` (the real service was never touched;
 * decision D9). `EVIDENCE` lists them, and a test fails a cell that has none.
 */
export const EVIDENCE = ['declared', 'emulator', 'tested', 'design', 'not run'] as const;

export const COLUMNS = ['gcp-pubsub', 'aws-sqs', 'postgres', 'memory'] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_TITLES: Record<Column, string> = {
  'gcp-pubsub': 'Pub/Sub (`gcp-pubsub`)',
  'aws-sqs': 'SQS (`aws-sqs`)',
  postgres: 'Postgres (`postgres`)',
  memory: 'Memory (tests only)',
};

type Row = readonly [label: string, ...cells: [string, string, string, string]];

export const MATRIX: readonly Row[] = [
  [
    'Delay mechanism',
    'None per message. A delayed job is rung by the tick when it is due: tick speed (emulator, design)',
    '`DelaySeconds` on the bell, rounded **up** to a whole second, inside the 900 s window. The tick rings the rest (emulator)',
    'None: the poll loop claims a job once it is due (tested)',
    'The queue holds the bell until due, on the process clock (tested)',
  ],
  [
    'A delay past the window',
    'Every positive delay is past a window of 0: `delay-too-long`, never clamped (emulator)',
    '`delay-too-long`, never clamped; the store leaves the bell to the tick (emulator)',
    'No window: nothing is too long (declared)',
    'No window: nothing is too long (declared)',
  ],
  [
    'Ordering',
    'None promised; bells are fungible and the store orders the claim (design)',
    'Standard queue: best effort, none promised (design)',
    'None promised; the poll finds the next claimable job (tested)',
    'None promised; the in-process queue hands bells out as they are due (design)',
  ],
  [
    'Delivery guarantee',
    'At least once: a bell can arrive twice and the claim is exclusive (emulator; duplicate-bell scenario)',
    'At least once: a standard queue can duplicate; ElasticMQ never does (emulator, design)',
    'A notification and a poll: a lost one is repaired by the next poll (tested)',
    'A bell not settled comes back after the visibility timeout (tested)',
  ],
  [
    'Dead-letter queue',
    'Dead-letter topic after 5 delivery attempts. A bell in it is a metric and is never replayed (emulator: wiring only)',
    'Redrive after 5 receives to a dead-letter queue. A bell in it is a metric and is never replayed (emulator)',
    'None: a bell is not a message body, so nothing can be malformed (tested)',
    'None: an unhandled bell is redelivered (tested)',
  ],
  [
    'Queue statistics',
    'Cloud Monitoring: about 5 minutes behind plus the cache. `inFlight` unknown, `delayed` 0. `unavailable` on the emulator (declared; real: not run)',
    '`GetQueueAttributes`, up to about a minute stale; age from CloudWatch, about 5 minutes behind plus the cache. `unavailable` age on ElasticMQ (declared; real: not run)',
    'Exact counts read from the store (`postgres-counts`), staleness 0 (tested)',
    'Exact, staleness 0 (tested)',
  ],
  [
    'Authentication',
    'Application Default Credentials; a service account with publisher and subscriber roles. None on the emulator (design; real: not run)',
    'The default AWS credential chain (a task role); the region is explicit and never read from the machine (design; real: not run)',
    'The database credentials only; `LISTEN` needs a direct URL, not a pooler (tested)',
    'None (tested)',
  ],
  [
    'Cost drivers',
    'Data volume published and delivered, a Cloud Scheduler job, Cloud Monitoring reads. Not measured (not run)',
    'Requests: about 1.1 to 1.6 per job with room to receive (deletes batched), plus idle long polls and CloudWatch reads (emulator count; price not checked)',
    'Database load: one poll per queue per worker per interval (tested)',
    'None (tested)',
  ],
  [
    'Known limits',
    'No per-message delay or backoff the application controls; retry backoff is the subscription policy (design)',
    '10 bells per batch; 900 s delay; a bell is one request however many jobs it stands for (declared)',
    'A pooler in transaction mode cannot carry `LISTEN`: poll only (tested)',
    'One process: bells never leave it (tested)',
  ],
];

/** Where an emulator differs from the service, so a green emulator run is not read as more than it is. */
export const EMULATOR_ONLY: ReadonlyArray<readonly [what: string, difference: string]> = [
  [
    'Pub/Sub emulator: retry backoff',
    'The emulator\'s backoff is not exponential, so the retry curve of a nacked bell is not that of the service.',
  ],
  [
    'Pub/Sub emulator: flow control',
    'It ignores flow control, so the `maxHeld` bound on bells a busy worker holds is not exercised.',
  ],
  [
    'Pub/Sub emulator: dead-lettering and IAM',
    'Dead-letter wiring is checked, not the service\'s behaviour under real IAM; throughput is not measured.',
  ],
  [
    'ElasticMQ: receive counts',
    'Exact on ElasticMQ; approximate on SQS (about a minute stale). `stats` says so in `source` and `maxStalenessMs`.',
  ],
  [
    'ElasticMQ: stale receipt handles',
    'A delete of a stale handle answers `ReceiptHandleIsInvalid` and leaves the message; SQS may answer success without deleting. The transport treats both as harmless.',
  ],
  [
    'ElasticMQ: partial batch failures (`Failed[]`)',
    'ElasticMQ returns it for a bad entry, but no bell the transport can send makes one refuse. The parsing is covered by stub-client tests; a real partial failure was never produced.',
  ],
  [
    'ElasticMQ: redrive',
    'A message moves to the dead-letter queue as soon as it was received `maxReceiveCount` times; SQS moves it on the next receive.',
  ],
  [
    'ElasticMQ: duplicates and short receives',
    'It never duplicates, and fills a receive to 10 when it can; a standard SQS queue does neither.',
  ],
  [
    'ElasticMQ: CloudWatch',
    'There is none, so queue age and the dead-letter metric are tested against a stub client.',
  ],
];
