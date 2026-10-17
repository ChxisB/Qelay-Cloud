import { describe, expect, test } from 'bun:test';
import {
  defaultConnectionProfile,
  sanitizeProfiles,
} from '../src/components/dashboard/stores/connectionProfiles';

const defaults = { baseUrl: '/api', agentBaseUrl: 'http://localhost:6800', refreshMs: 3000 };

describe('connection profile names after the Qelay rebrand', () => {
  test('a new install gets a product-neutral default name', () => {
    expect(defaultConnectionProfile(defaults).name).toBe('Local server');
    expect(sanitizeProfiles(undefined, defaults)[0]?.name).toBe('Local server');
  });

  test('a name the user already saved is never rewritten', () => {
    const saved = [
      { id: 'default', name: 'Local Qelay', baseUrl: '/api' },
      { id: 'prod', name: 'Qelay', baseUrl: 'https://queue.example.com' },
    ];
    expect(sanitizeProfiles(saved, defaults).map((p) => p.name)).toEqual(['Local Qelay', 'Qelay']);
  });

  test('a profile saved without a name falls back to "Server <n>"', () => {
    const saved = [
      { id: 'a', baseUrl: '/api' },
      { id: 'b', name: '   ', baseUrl: 'https://queue.example.com' },
    ];
    expect(sanitizeProfiles(saved, defaults).map((p) => p.name)).toEqual(['Server 1', 'Server 2']);
  });
});
