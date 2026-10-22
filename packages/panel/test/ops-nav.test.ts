import { describe, expect, test } from 'bun:test';
import { locateNav } from '../src/components/layout/navConfig';
import { titleFor } from '../src/components/layout/pageTitle';

describe('the ops pages in the shell', () => {
  test('Health is one item of Monitoring, current on each of its four pages', () => {
    for (const path of ['/deployment', '/diagnostics', '/transport', '/usage'])
      expect(locateNav(path), path).toEqual({ section: 'Monitor', label: 'Health' });
  });

  test('their tab titles name the page', () => {
    expect(titleFor('/transport')).toContain('Job delivery');
    expect(titleFor('/deployment')).toContain('Deployment');
  });
});
