import { createElement } from 'react';
import type { TransportView } from '../src/lib/ops/types';
import { Transport } from '../src/pages/control/Transport';
import { settle } from './domSetup';
import { mountRouted, serveOps } from './ops.helpers';

export async function show(view: TransportView, extra: Record<string, unknown> = {}) {
  const seen = serveOps({ ...extra, '/transport': view });
  const page = mountRouted(createElement(Transport), '/transport');
  await settle(80);
  return { page, seen };
}

export const rowFor = (host: HTMLElement, name: string): string => {
  const rows = [...host.querySelectorAll('tbody tr')];
  const row = rows.find((r) => r.textContent?.includes(name));
  return row?.textContent ?? '';
};
