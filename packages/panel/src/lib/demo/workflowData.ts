import type { Json } from './shared';

/** A fixed clock so the demo reads the same on every visit (2026-08-04). */
export const DEMO_NOW = 1785839100000;
const T0 = 1785838920000;

export const FAN_OUT_STEP = 'notify-warehouse';
export const FAN_OUT_ITEMS = 10_000;
/** The 10,000 iterations of the demo's for-each by status; iteration `i` takes the status its index falls in. */
export const FAN_OUT_COUNTS = { completed: 9_862, running: 8, pending: 120, failed: 10 } as const;

const step = (name: string, compensates = false) => ({
  name,
  retry: 3,
  timeout: 30_000,
  compensates,
});

export const ORDER_GRAPH = [
  { type: 'step', step: step('validate') },
  { type: 'step', step: step('charge', true) },
  { type: 'step', step: step('reserve-inventory', true) },
  { type: 'forEach', maxIterations: FAN_OUT_ITEMS, step: step(FAN_OUT_STEP) },
  { type: 'subWorkflow', name: 'shipping', timeout: 3_600_000 },
  { type: 'pivot' },
  { type: 'step', step: step('confirm') },
];

const REFUND_GRAPH = [
  { type: 'step', step: step('load-order') },
  { type: 'step', step: step('revoke-shipment', true) },
  { type: 'step', step: step('refund-payment', true) },
];

const ONBOARDING_GRAPH = [
  { type: 'step', step: step('create-account') },
  { type: 'step', step: step('send-verification') },
  { type: 'waitFor', event: 'email-verified', timeout: 86_400_000 },
  { type: 'step', step: step('activate') },
];

const CLOSE_GRAPH = [
  { type: 'step', step: step('lock-period') },
  { type: 'step', step: step('aggregate') },
  { type: 'step', step: step('publish') },
];

const done = (name: string, result: unknown, at = 0, compensatable = false): Json => ({
  name,
  status: 'completed',
  attempts: 1,
  startedAt: T0 + at,
  completedAt: T0 + at + 400,
  durationMs: 400,
  compensatable,
  error: null,
  result,
  childExecutionId: null,
  compensation: null,
  loopIndex: null,
});

/** One iteration of the for-each, by index; the same index always reads the same. */
export function fanOutIteration(index: number): Json {
  const { completed, running, failed } = FAN_OUT_COUNTS;
  const status =
    index < completed
      ? 'completed'
      : index < completed + running
        ? 'running'
        : index < completed + running + failed
          ? 'failed'
          : 'pending';
  const base: Json = {
    name: `${FAN_OUT_STEP}:${index}`,
    status,
    attempts: status === 'pending' ? 0 : 1,
    startedAt: status === 'pending' ? null : T0 + 20_000 + index,
    completedAt: status === 'completed' || status === 'failed' ? T0 + 20_500 + index : null,
    durationMs: status === 'completed' || status === 'failed' ? 500 : null,
    compensatable: false,
    error: status === 'failed' ? 'Warehouse API returned 503' : null,
    childExecutionId: null,
    compensation: null,
    loopIndex: index,
    loopItem: { warehouse: `wh_${String(index).padStart(5, '0')}` },
  };
  return status === 'completed' ? { ...base, result: { notified: true } } : base;
}

export interface DemoRun {
  id: string;
  workflowName: string;
  state: string;
  definitionHash: string | null;
  parentExecutionId: string | null;
  currentNodeIndex: number;
  rollbackStatus: string | null;
  failureReason: string | null;
  committedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  wait: { event: string; deadlineAt: number | null } | null;
  input: unknown;
  output: { step: string; result: unknown } | null;
  signals: { event: string; payload?: unknown }[];
  graph: Json[];
  steps: Json[];
  children: { step: string; executionId: string }[];
  compensation: {
    status: string;
    eligible: number;
    compensated: number;
    failed: number;
    skipped: number;
    failures: { step: string; error: string | null }[];
  };
}

const run = (
  partial: Partial<DemoRun> & Pick<DemoRun, 'id' | 'workflowName' | 'state' | 'graph' | 'steps'>
): DemoRun => ({
  definitionHash: null,
  parentExecutionId: null,
  currentNodeIndex: 0,
  rollbackStatus: null,
  failureReason: null,
  committedAt: null,
  version: 1,
  createdAt: T0,
  updatedAt: T0 + 120_000,
  wait: null,
  input: {},
  output: null,
  signals: [],
  children: [],
  compensation: {
    status: 'none',
    eligible: 0,
    compensated: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  },
  ...partial,
});

export function seedRuns(): DemoRun[] {
  return [
    run({
      id: 'wf-order-2026-0804',
      workflowName: 'order-fulfillment',
      state: 'running',
      definitionHash: 'sha256:8a03c8e91db4d8f5',
      currentNodeIndex: 3,
      version: 7,
      input: { orderId: 'ord_9a3f', customerId: 'cus_417', total: 129.9 },
      graph: ORDER_GRAPH,
      steps: [
        done('validate', { valid: true }),
        done('charge', { paymentId: 'pay_802' }, 500, true),
        done('reserve-inventory', { reservationId: 'res_551' }, 1_000, true),
        {
          ...done(FAN_OUT_STEP, null, 20_000),
          status: 'running',
          completedAt: null,
          durationMs: null,
          result: undefined,
          loopIndex: null,
          fanOut: {
            iterations: FAN_OUT_ITEMS,
            byStatus: {
              pending: FAN_OUT_COUNTS.pending,
              running: FAN_OUT_COUNTS.running,
              completed: FAN_OUT_COUNTS.completed,
              failed: FAN_OUT_COUNTS.failed,
            },
            compensation: { compensated: 0, failed: 0, skipped: 0 },
          },
        },
      ],
      compensation: {
        status: 'none',
        eligible: 2,
        compensated: 0,
        failed: 0,
        skipped: 0,
        failures: [],
      },
    }),
    run({
      id: 'wf-refund-2026-0803',
      workflowName: 'refund-order',
      state: 'compensation-stuck',
      definitionHash: 'sha256:cc89ab41c1b2f011',
      currentNodeIndex: 2,
      version: 9,
      rollbackStatus: 'stuck',
      failureReason: 'Refund provider unavailable after 3 attempts',
      createdAt: T0 - 87_720_000,
      updatedAt: T0 - 87_600_000,
      input: { orderId: 'ord_772', reason: 'customer_request' },
      signals: [{ event: 'approved', payload: { actor: 'ops@example.com' } }],
      graph: REFUND_GRAPH,
      steps: [
        done('load-order', { paymentId: 'pay_331' }),
        {
          ...done('revoke-shipment', null, 500, true),
          result: undefined,
          compensation: { status: 'compensated', at: T0 + 2_000, error: null },
        },
        {
          ...done('refund-payment', null, 1_000, true),
          status: 'failed',
          attempts: 3,
          result: undefined,
          error: 'Provider timeout',
          compensation: {
            status: 'compensation-failed',
            at: T0 + 3_000,
            error: 'Provider unavailable',
          },
        },
      ],
      compensation: {
        status: 'stuck',
        eligible: 2,
        compensated: 1,
        failed: 1,
        skipped: 0,
        failures: [{ step: 'refund-payment', error: 'Provider unavailable' }],
      },
    }),
    run({
      id: 'wf-signup-2026-0802',
      workflowName: 'customer-onboarding',
      state: 'waiting',
      definitionHash: 'sha256:5e1c0d9a77b3e402',
      currentNodeIndex: 2,
      version: 3,
      createdAt: T0 - 174_000_000,
      updatedAt: T0 - 173_900_000,
      wait: { event: 'email-verified', deadlineAt: DEMO_NOW + 80_000_000 },
      input: { customerId: 'cus_881', plan: 'pro' },
      graph: ONBOARDING_GRAPH,
      steps: [
        done('create-account', { accountId: 'acc_881' }),
        done('send-verification', { messageId: 'msg_194' }, 500),
      ],
    }),
    run({
      id: 'wf-month-close-2026-07',
      workflowName: 'month-end-close',
      state: 'completed',
      definitionHash: 'sha256:78b6fd851d8b32a1',
      currentNodeIndex: 3,
      version: 5,
      rollbackStatus: 'not-applicable',
      createdAt: T0 - 260_000_000,
      updatedAt: T0 - 259_935_000,
      input: { period: '2026-07' },
      output: { step: 'publish', result: { reportId: 'rep_2026_07' } },
      graph: CLOSE_GRAPH,
      steps: [
        done('lock-period', { locked: true }),
        done('aggregate', { entries: 1842 }, 500),
        done('publish', { reportId: 'rep_2026_07' }, 1_000),
      ],
    }),
    run({
      id: 'wf-import-legacy-441',
      workflowName: 'legacy-import',
      state: 'failed',
      rollbackStatus: 'not-applicable',
      failureReason: 'Input schema rejected row 441',
      version: 4,
      createdAt: T0 - 346_000_000,
      updatedAt: T0 - 345_990_000,
      input: { batch: 'legacy-2026-07' },
      graph: [{ type: 'step', step: step('validate') }],
      steps: [
        {
          ...done('validate', null),
          status: 'failed',
          result: undefined,
          error: 'Invalid customer reference at row 441',
        },
      ],
    }),
  ];
}
