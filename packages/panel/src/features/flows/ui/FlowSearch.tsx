import { Card } from '@/components/ui/Card';

export function FlowSearch({
  input,
  error,
  onInput,
  onSubmit,
}: {
  input: string;
  error: string | null;
  onInput: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <Card className="mb-6">
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-3">
        <input
          name="flow-job-id"
          autoComplete="off"
          spellCheck={false}
          maxLength={1024}
          value={input}
          onChange={(event) => onInput(event.target.value)}
          placeholder="Job ID of a flow or of a job in one"
          aria-label="Job ID"
          aria-describedby="flow-input-help"
          aria-invalid={error !== null}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
        >
          Open flow
        </button>
      </form>
      <p id="flow-input-help" className={`mt-2 text-xs ${error ? 'text-danger' : 'text-faint'}`}>
        {error ?? 'A job of a flow opens the flow it belongs to, with that job selected.'}
      </p>
    </Card>
  );
}
