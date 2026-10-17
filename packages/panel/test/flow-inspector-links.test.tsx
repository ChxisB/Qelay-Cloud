import { afterEach, describe, expect, test } from 'bun:test';
import type { JobFull } from '../src/lib/bqTypes';
import { JobFlowLinks } from '../src/pages/control/job/JobFlowLinks';
import { mountFlows, unmountAll } from './flow.helpers';
import './domSetup';

afterEach(unmountAll);

function show(job: JobFull) {
  return mountFlows(<JobFlowLinks job={job} />, '/job');
}

const hrefs = (host: ParentNode) =>
  [...host.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

describe('flow links on the job inspector', () => {
  test('draws nothing for a job that is in no flow', () => {
    const { host } = show({ id: 'plain', parentId: null, childrenIds: [], flowRoot: null });
    expect(host.textContent).toBe('');
    expect(show({ id: 'older-server' }).host.textContent).toBe('');
  });

  test('a child links to its flow at that job, and to its parent', () => {
    const { host } = show({
      id: 'child 1',
      parentId: 'par/ent',
      flowRoot: 'root',
      childrenIds: [],
    });
    expect(host.textContent).toContain('Flow');
    expect(hrefs(host)).toEqual([
      ['root', '/flows?root=root&node=child+1'],
      ['par/ent', '/job?id=par%2Fent'],
    ]);
    expect(host.textContent).not.toContain('Parent of');
  });

  test('the root of a flow is called "This flow" and opens the flow with the root selected, as it is by default', () => {
    const { host } = show({
      id: 'root',
      flowRoot: 'root',
      parentId: null,
      childrenIds: ['a', 'b'],
    });
    expect(hrefs(host)).toEqual([
      ['This flow', '/flows?root=root'],
      ['a', '/job?id=a'],
      ['b', '/job?id=b'],
    ]);
    expect(host.textContent).toContain('Parent of 2 jobs');
    expect(host.textContent).not.toContain('Child of');
  });

  test('one child is "1 job"', () => {
    const { host } = show({ id: 'p', flowRoot: 'p', childrenIds: ['only'] });
    expect(host.textContent).toContain('Parent of 1 job');
    expect(host.textContent).not.toContain('Parent of 1 jobs');
  });

  test('a parent with many children lists ten and points to the flow for the rest', () => {
    const childrenIds = Array.from({ length: 25 }, (_, index) => `c${index}`);
    const { host } = show({ id: 'p', flowRoot: 'p', childrenIds });
    const links = hrefs(host);
    expect(links.filter(([, href]) => String(href).startsWith('/job?id='))).toHaveLength(10);
    expect(links.map(([text]) => text)).toContain('c9');
    expect(links.map(([text]) => text)).not.toContain('c10');
    expect(host.textContent).toContain('Parent of 25 jobs');
    expect(host.textContent).toContain('and 15 more.');
    expect(links.at(-1)).toEqual(['See them in the flow', '/flows?root=p']);
  });

  test('without a flow root the overflow has no link to follow', () => {
    const childrenIds = Array.from({ length: 12 }, (_, index) => `c${index}`);
    const { host } = show({ id: 'p', childrenIds });
    expect(host.textContent).toContain('and 2 more.');
    expect(host.textContent).not.toContain('See them in the flow');
  });
});
