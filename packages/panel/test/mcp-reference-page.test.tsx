import { describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { McpServer } from '../src/pages/control/McpServer';
import { ensureDom } from './domSetup';

ensureDom();

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, unmount: () => act(() => root.unmount()) };
}

describe('MCP reference page', () => {
  test('renders the complete static contract and safe external documentation link', () => {
    const view = render(createElement(MemoryRouter, null, createElement(McpServer)));
    expect(view.host.textContent).toContain('73 total');
    expect(view.host.textContent).toContain('12');
    expect(view.host.textContent).toContain('qelay://queues');
    expect(view.host.textContent).toContain('qelay_incident_response');
    expect(view.host.textContent).toContain('qelay-mcp');
    expect(view.host.textContent).toContain('QELAY_TOKEN');
    expect(view.host.querySelectorAll('button[aria-label="Copy to clipboard"]')).toHaveLength(4);
    expect(view.host.textContent).toContain(
      'bun add --exact qelay@2.9.11 @modelcontextprotocol/sdk@1.30.0'
    );
    expect(view.host.textContent).toContain('node_modules/.bin/qelay-mcp');
    const docs = view.host.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(docs?.rel).toContain('noopener');
    expect(docs?.rel).toContain('noreferrer');
  });

  test('counts the tool total from the groups shown, and the sample path is the Qelay file', () => {
    const view = render(createElement(MemoryRouter, null, createElement(McpServer)));
    // A group's row is its name then its count; the Resources and Prompts counts are not rows of a group.
    const counts = [...view.host.querySelectorAll('span.tnum')]
      .filter((count) => count.previousElementSibling?.className.includes('font-bold'))
      .map((count) => Number(count.textContent));
    expect(counts.length).toBeGreaterThan(10);
    const total = counts.reduce((sum, count) => sum + count, 0);
    expect(view.host.textContent).toContain(`${total} total`);
    expect(view.host.textContent).toContain(`Counts total ${total}.`);
    expect(view.host.textContent).toContain('./data/qelay.db');
    expect(view.host.textContent).not.toContain('bunq.db');
    view.unmount();
  });
});
