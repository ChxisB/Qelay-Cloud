import {
  describe,
  expect,
  installTestHooks,
  json,
  loadAllQueuePages,
  queuePage,
  resolveQueueSelection,
  test,
} from './queue-settings.helpers';

installTestHooks();

describe('queue discovery: paging and selection integrity', () => {
  test('loads every 500-item discovery page', async () => {
    const names = Array.from({ length: 501 }, (_, index) => `q-${index}`);
    const offsets: number[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      const pageNames = names.slice(offset, offset + 500);
      return Promise.resolve(json(queuePage(pageNames, offset, names.length)));
    }) as typeof fetch;

    const result = await loadAllQueuePages();
    expect(offsets).toEqual([0, 500]);
    expect(result.queues).toHaveLength(501);
    expect(result.queues.at(-1)?.name).toBe('q-500');
  });

  test('bounds a moving total instead of chasing a growing queue set', async () => {
    const offsets: number[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      if (offset === 0) {
        return Promise.resolve(
          json(
            queuePage(
              Array.from({ length: 500 }, (_, index) => `q-${index}`),
              0,
              501
            )
          )
        );
      }
      return Promise.resolve(
        json(
          queuePage(
            Array.from({ length: 500 }, (_, index) => `q-${500 + index}`),
            500,
            1_001
          )
        )
      );
    }) as typeof fetch;

    await expect(loadAllQueuePages()).rejects.toThrow(
      'total moved from 501 to 1001. Retry the snapshot.'
    );
    expect(offsets).toEqual([0, 500]);
  });

  test('rejects changed offsets and overlapping pages without another fetch', async () => {
    const firstNames = Array.from({ length: 500 }, (_, index) => `q-${index}`);
    let mode: 'offset' | 'overlap' = 'offset';
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls % 2 === 1) return Promise.resolve(json(queuePage(firstNames, 0, 501)));
      return Promise.resolve(json(queuePage(['q-499'], mode === 'offset' ? 499 : 500, 501)));
    }) as typeof fetch;

    await expect(loadAllQueuePages()).rejects.toThrow('Malformed /dashboard/queues response.');
    expect(calls).toBe(2);

    mode = 'overlap';
    await expect(loadAllQueuePages()).rejects.toThrow('queue "q-499" appeared more than once');
    expect(calls).toBe(4);
  });

  test('rejects an impractically large first snapshot before requesting page two', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        json(
          queuePage(
            Array.from({ length: 500 }, (_, index) => `q-${index}`),
            0,
            100_001
          )
        )
      );
    }) as typeof fetch;

    await expect(loadAllQueuePages()).rejects.toThrow('safe dashboard limit of 100000');
    expect(calls).toBe(1);
  });

  test('a selection removed by discovery retargets deterministically', () => {
    expect(resolveQueueSelection('q-b', [{ name: 'q-a' }, { name: 'q-b' }])).toBe('q-b');
    expect(resolveQueueSelection('removed', [{ name: 'q-a' }, { name: 'q-b' }])).toBe('q-a');
    expect(resolveQueueSelection('removed', [])).toBe('');
  });
});
