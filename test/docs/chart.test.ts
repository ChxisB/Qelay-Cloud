import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/** The Helm chart's autoscaling: off unless asked for, and never past the database's connections. Needs `helm`. */
const root = join(import.meta.dir, '../..');
const chart = join(root, 'charts/qelay');
const HELM = Bun.which('helm') !== null;
if (!HELM) console.warn('chart.test.ts: helm is not installed, so the chart tests are skipped');

function render(...extra: string[]): { out: string; err: string; ok: boolean } {
  const run = Bun.spawnSync(
    ['helm', 'template', 'qelay', chart, '-f', join(chart, 'ci/values.yaml'), ...extra],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  return { out: run.stdout.toString(), err: run.stderr.toString(), ok: run.exitCode === 0 };
}

const kinds = (out: string, kind: string): number => out.split(`\nkind: ${kind}\n`).length - 1;
const layer = (name: string) => ['-f', join(chart, 'ci', name)];

describe.skipIf(!HELM)('helm chart: autoscaling', () => {
  test('by default no autoscaler or disruption budget is made and every deployment keeps its replicas', () => {
    const { out, ok } = render();
    expect(ok).toBe(true);
    for (const kind of ['HorizontalPodAutoscaler', 'ScaledObject', 'PodDisruptionBudget']) {
      expect([kind, kinds(out, kind)]).toEqual([kind, 0]);
    }
    expect(out.match(/^ {2}replicas: /gm)).toHaveLength(6);
  });

  test('turned on, the API, ingest and sender scale on CPU, a worker on its triggers, and none sets replicas', () => {
    const { out, ok } = render(...layer('autoscaling.yaml'));
    expect(ok).toBe(true);
    expect(kinds(out, 'HorizontalPodAutoscaler')).toBe(3);
    expect(kinds(out, 'ScaledObject')).toBe(1);
    expect(kinds(out, 'PodDisruptionBudget')).toBe(2);
    // Only the panel and the tick loop are left with a fixed count.
    expect(out.match(/^ {2}replicas: /gm)).toHaveLength(2);
  });

  test('a fleet that does not fit database.maxConnections at its largest is refused, and says what it needs', () => {
    const { err, ok } = render(...layer('autoscaling.yaml'), '--set', 'database.maxConnections=60');
    expect(ok).toBe(false);
    expect(err).toContain('needs 86 database connections');
    expect(render(...layer('autoscaling.yaml'), '--set', 'database.pooler=transaction').ok).toBe(
      true
    );
  });

  test('CPU autoscaling without a CPU request is refused', () => {
    const { err, ok } = render('--set', 'api.autoscaling.enabled=true');
    expect(ok).toBe(false);
    expect(err).toContain('resources.requests.cpu');
  });
});
