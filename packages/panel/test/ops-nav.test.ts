import { describe, expect, test } from 'bun:test';
import { locateNav } from '../src/components/layout/navConfig';
import { titleFor } from '../src/components/layout/pageTitle';

describe('the ops pages in the shell', () => {
  test('Transport and Deployment are in Monitoring', () => {
    expect(locateNav('/transport')).toEqual({ section: 'Monitoring', label: 'Transport' });
    expect(locateNav('/deployment')).toEqual({ section: 'Monitoring', label: 'Deployment' });
  });

  test('their tab titles name the page', () => {
    expect(titleFor('/transport')).toContain('Transport');
    expect(titleFor('/deployment')).toContain('Deployment');
  });
});
