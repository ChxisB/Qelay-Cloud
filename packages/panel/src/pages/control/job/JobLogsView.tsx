import type { MutableRefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/form';
import type { LogLevel } from './jobLogsTransport';

interface JobLogsViewProps {
  logs: unknown[];
  count: number;
  loading: boolean;
  busy: boolean;
  error: string | null;
  message: string;
  level: LogLevel;
  draftRevision: MutableRefObject<number>;
  setMessage: (value: string) => void;
  setLevel: (value: LogLevel) => void;
  load: () => void;
  clear: () => void;
  add: (message: string, level: string) => void;
}

export function JobLogsView(props: JobLogsViewProps) {
  const { logs, count, loading, busy, error, message, level, draftRevision } = props;
  return (
    <Card>
      <CardHeader
        title="Logs"
        action={
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-muted">{count}</span>
            <Button size="sm" disabled={loading || busy} onClick={props.load}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy || logs.length === 0}
              onClick={props.clear}
            >
              Clear logs
            </Button>
          </div>
        }
      />
      {error && <p className="mb-3 text-[13px] font-semibold text-danger">{error}</p>}
      {logs.length === 0 ? (
        <p className="text-[13px] text-muted">No log lines recorded for this job.</p>
      ) : (
        // A scroll area must take the keyboard, so the dark log is a named, focusable region.
        <div
          role="region"
          aria-label="Job log lines"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll area must take the keyboard
          tabIndex={0}
          className="max-h-64 overflow-auto rounded-control bg-log-bg px-3.5 py-3"
        >
          <ol className="flex flex-col gap-1">
            {logs.map((line, index) => (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- append-only server log, stable order
                key={index}
                className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-log-fg"
              >
                {typeof line === 'string' ? line : JSON.stringify(line)}
              </li>
            ))}
          </ol>
        </div>
      )}
      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const submitted = event.currentTarget.elements.namedItem(
            'job-log-message'
          ) as HTMLInputElement | null;
          const submittedLevel = event.currentTarget.elements.namedItem(
            'job-log-level'
          ) as HTMLSelectElement | null;
          props.add(submitted?.value ?? message, submittedLevel?.value ?? level);
        }}
      >
        <Input
          aria-label="Log message"
          name="job-log-message"
          autoComplete="off"
          value={message}
          onInput={(event) => {
            draftRevision.current += 1;
            props.setMessage(event.currentTarget.value);
          }}
          placeholder="Add a log line…"
          className="min-w-48 flex-1"
        />
        <div className="w-28">
          <Select
            aria-label="Log level"
            name="job-log-level"
            value={level}
            onChange={(event) => {
              draftRevision.current += 1;
              props.setLevel(event.target.value as LogLevel);
            }}
          >
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </Select>
        </div>
        <Button type="submit" size="sm" disabled={busy || message.trim() === ''}>
          Add
        </Button>
      </form>
    </Card>
  );
}
