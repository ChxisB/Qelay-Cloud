import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/form';

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
        <Input
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
          className="min-w-0 flex-1 font-mono text-sm"
        />
        <Button type="submit" variant="primary" disabled={!input.trim()}>
          Open flow
        </Button>
      </form>
      <p
        id="flow-input-help"
        className={`mt-2 text-[13px] ${error ? 'font-semibold text-danger' : 'text-muted'}`}
      >
        {error ?? 'A job of a flow opens the flow it belongs to, with that job selected.'}
      </p>
    </Card>
  );
}
