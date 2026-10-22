import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/form';
import type { WebhookFull } from '@/lib/bqTypes';
import { EVENT_CHIPS, RANGES, routeLine } from './model';

export interface EventFilterValues {
  route: string;
  status: string;
  range: string;
  code: string;
  text: string;
}

/**
 * The Events screen's filters. Connection, status and time go to the server; the HTTP code and the
 * free text only narrow the page that is loaded, and the hint says so.
 */
export function EventFilters({
  values,
  routes,
  onChange,
  action,
}: {
  values: EventFilterValues;
  routes: readonly WebhookFull[];
  onChange: (key: keyof EventFilterValues, value: string) => void;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter events by status" className="flex flex-wrap gap-2">
          {EVENT_CHIPS.map((chip) => (
            <Button
              key={chip.value}
              size="sm"
              variant={values.status === chip.value ? 'primary' : 'default'}
              aria-pressed={values.status === chip.value}
              onClick={() => onChange('status', chip.value)}
            >
              {chip.label}
            </Button>
          ))}
        </div>
        <span className="grow" />
        {action}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          aria-label="Connection"
          value={values.route}
          onChange={(event) => onChange('route', event.target.value)}
        >
          <option value="">All connections</option>
          {routes.map((route) => (
            <option key={route.id} value={route.id}>
              {routeLine(route)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Time range"
          value={values.range}
          onChange={(event) => onChange('range', event.target.value)}
        >
          {RANGES.map((range) => (
            <option key={range.value} value={range.value}>
              {range.label}
            </option>
          ))}
        </Select>
        <Input
          aria-label="HTTP code"
          value={values.code}
          onInput={(event) => onChange('code', event.currentTarget.value)}
          inputMode="numeric"
          maxLength={3}
          placeholder="HTTP code, e.g. 5"
        />
        <Input
          aria-label="Search this page"
          value={values.text}
          onInput={(event) => onChange('text', event.currentTarget.value)}
          maxLength={100}
          placeholder="Job, queue, event or error"
        />
      </div>
      <p className="m-0 text-xs text-muted">
        HTTP code and search narrow the events on this page only. Status, connection and time search
        the whole history.
      </p>
    </div>
  );
}
