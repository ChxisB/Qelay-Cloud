import { describe, expect, test } from 'bun:test';
import { DefinitionGraph } from '../src/features/workflows/ui/DefinitionGraph';
import { click } from './control-dom.helpers';
import { mountFlows } from './flow.helpers';
import { installWorkflowHooks, openWorkflows } from './workflow.helpers';

installWorkflowHooks();

const at = (id: string) => `/workflows?execution=${id}&tab=graph`;
const nodes = (host: ParentNode) =>
  [...host.querySelectorAll('ol[aria-label="Nodes of the workflow"] > li')] as HTMLElement[];
const detail = (host: ParentNode) => host.querySelector('section[aria-label^="Node "]');

describe('workflow definition graph', () => {
  test('a running run is marked where it is, with what is behind and ahead of it', async () => {
    const { host } = await openWorkflows(at('wf-order-2026-0804'));
    const boxes = nodes(host);
    expect(boxes).toHaveLength(7);
    expect(boxes.map((box) => box.getAttribute('aria-current'))).toEqual([
      null,
      null,
      null,
      'step',
      null,
      null,
      null,
    ]);
    expect(boxes[0]?.textContent).toContain('Done');
    expect(boxes[3]?.textContent).toContain('The run is here');
    expect(boxes[6]?.textContent).toContain('Not reached');
    expect(host.querySelector('path[stroke-dasharray]')).toBeNull();
  });

  test('it opens on the node the run is at, with its counts, and a click opens another', async () => {
    const { host } = await openWorkflows(at('wf-order-2026-0804'));
    expect(detail(host)?.getAttribute('aria-label')).toBe('Node 4');
    expect(detail(host)?.textContent).toContain('10 failed');

    click(nodes(host)[0]?.querySelector('button') as HTMLElement);
    expect(detail(host)?.getAttribute('aria-label')).toBe('Node 1');
    expect(detail(host)?.textContent).toContain('validate');
    expect(host.querySelector('pre[aria-label="Result of validate"]')?.textContent).toContain(
      '"valid": true'
    );
    expect(nodes(host)[0]?.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  test('a node that is not one step shows what it does and no record', async () => {
    const { host } = await openWorkflows(at('wf-order-2026-0804'));
    click(nodes(host)[5]?.querySelector('button') as HTMLElement);
    expect(detail(host)?.textContent).toContain('point of no return');
    expect(detail(host)?.querySelector('pre')).toBeNull();
  });

  test('a step with no record yet says so', async () => {
    const { host } = await openWorkflows(at('wf-order-2026-0804'));
    click(nodes(host)[6]?.querySelector('button') as HTMLElement);
    expect(detail(host)?.textContent).toContain('No step with this name has started.');
  });

  test('a run that is rolling back draws the dashed line back and says it is stuck', async () => {
    const { host } = await openWorkflows(at('wf-refund-2026-0803'));
    expect(host.querySelector('[role="note"]')?.textContent).toContain('rollback is stuck');
    expect(host.querySelector('path[stroke-dasharray]')?.getAttribute('class')).toContain(
      'stroke-danger'
    );
    expect(nodes(host).map((box) => box.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'step',
    ]);
    expect(nodes(host)[0]?.textContent).not.toContain('Done');
  });

  test('a finished run has done every node and none is current', async () => {
    const { host } = await openWorkflows(at('wf-month-close-2026-07'));
    expect(nodes(host).every((box) => box.textContent?.includes('Done'))).toBe(true);
    expect(nodes(host).some((box) => box.hasAttribute('aria-current'))).toBe(false);
    expect(detail(host)).toBeNull();
    expect(host.textContent).toContain('Choose a node');
  });

  test('a failed run is not marked, because the server does not say where it stopped', () => {
    const { host } = mountFlows(
      <DefinitionGraph
        definition={{
          hash: 'sha256:abc',
          revision: 'r1',
          firstSeenAt: 1,
          lastSeenAt: 2,
          served: true,
          graph: [
            { type: 'step', step: { name: 'a' } },
            { type: 'step', step: { name: 'b' } },
          ],
        }}
        currentNodeIndex={0}
        state="failed"
        steps={{ items: [], total: 0, limit: 25, offset: 0, hasMore: false }}
      />
    );
    expect(nodes(host)).toHaveLength(2);
    expect(host.textContent).not.toMatch(/Done|Not reached|The run is here/);
    expect(host.querySelector('[aria-current]')).toBeNull();
  });

  test('a run no worker announced a definition for says so on its page', async () => {
    const { host } = await openWorkflows(at('wf-import-legacy-441'));
    expect(host.textContent).toContain('No definition is recorded for this run');
    expect(nodes(host)).toHaveLength(0);
  });

  test('a run with no recorded definition still says so', () => {
    const { host } = mountFlows(
      <DefinitionGraph
        definition={null}
        currentNodeIndex={0}
        state="running"
        steps={{ items: [], total: 0, limit: 25, offset: 0, hasMore: false }}
      />
    );
    expect(host.textContent).toContain('No definition is recorded for this run');
    expect(nodes(host)).toHaveLength(0);
  });

  test('a result the server cut keeps its marker and its note', () => {
    const marker = { $type: 'truncated', kind: 'string', length: 900_000, maxBytes: 65_536 };
    const { host } = mountFlows(
      <DefinitionGraph
        definition={{
          hash: 'sha256:abc',
          revision: 'r1',
          firstSeenAt: 1,
          lastSeenAt: 2,
          served: true,
          graph: [{ type: 'step', step: { name: 'charge' } }],
        }}
        currentNodeIndex={0}
        state="running"
        steps={{
          items: [
            {
              name: 'charge',
              status: 'completed',
              attempts: 1,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1,
              compensatable: false,
              error: null,
              result: { receipt: marker },
              resultTruncated: true,
              childExecutionId: null,
              compensation: null,
              loopIndex: null,
            },
          ],
          total: 1,
          limit: 25,
          offset: 0,
          hasMore: false,
        }}
      />
    );
    expect(detail(host)?.querySelector('[role="note"]')?.textContent).toContain('cut');
    expect(detail(host)?.querySelector('pre')?.textContent).toContain('"$type": "truncated"');
  });
});
