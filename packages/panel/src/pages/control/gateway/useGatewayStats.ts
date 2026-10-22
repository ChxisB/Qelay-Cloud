import { useSearchParams } from 'react-router-dom';
import { bq } from '@/lib/bq';
import { type PollOptions, usePolledData } from '@/lib/usePolledData';
import { RANGES, type RangeValue, rangeMs } from './model';

export const DEFAULT_RANGE: RangeValue = '24h';

/** The time range of a metrics screen: in the address (`?range=7d`), and a value it does not know is the default. */
export function useRange(): [RangeValue, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const range = RANGES.find((item) => item.value === params.get('range'))?.value ?? DEFAULT_RANGE;
  const setRange = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === DEFAULT_RANGE) next.delete('range');
    else next.set('range', value);
    setParams(next, { replace: true });
  };
  return [range, setRange];
}

/**
 * Every connection's last 24 hours in one read, for the list. A server that cannot group answers with an error and
 * the list shows no numbers: the caller reads `data` and ignores `error`.
 */
export const useGroupStats = () =>
  usePolledData(() => {
    const until = Date.now();
    return bq.webhookGroupStats({
      since: until - rangeMs('24h', DEFAULT_RANGE),
      until,
      buckets: 24,
    });
  }, []);

/**
 * The gateway's numbers for one connection (`route`) or all of them (`''`) over the range, kept fresh by
 * polling. `{ paused: true }` reads once per route and range, and again only on `refetch`.
 */
export const useGatewayStats = (route: string, range: string, options?: PollOptions) =>
  usePolledData(
    () => {
      const until = Date.now();
      return bq.webhookStats({
        since: until - rangeMs(range, DEFAULT_RANGE),
        until,
        ...(route === '' ? {} : { webhook: route }),
      });
    },
    [route, range],
    options
  );
