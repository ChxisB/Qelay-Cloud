import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import type { FlowRepository } from '../application/FlowRepository';
import { useFlowActions } from '../application/useFlowActions';
import { isFlowConnectionFailure, useFlowExplorer } from '../application/useFlowExplorer';
import { useFlowList } from '../application/useFlowList';
import { flowIdError } from '../domain/flowUrlState';
import { controlFlowRepository } from '../infrastructure/controlFlowRepository';
import { FlowExplorer } from './FlowExplorer';
import { FlowList } from './FlowList';
import { FlowSearch } from './FlowSearch';

export function FlowPage({ repository = controlFlowRepository }: { repository?: FlowRepository }) {
  const explorer = useFlowExplorer(repository);
  const flows = useFlowList(repository);
  const [input, setInput] = useState(explorer.root);
  const [inputError, setInputError] = useState<string | null>(null);
  const { flow, root, reload, close } = explorer;
  const actions = useFlowActions({
    repository,
    loaded: flow,
    reload,
    onRemoved: () => {
      close();
      flows.reload();
    },
  });

  useEffect(() => setInput(root), [root]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = input.trim();
    const problem = id ? flowIdError(id) : null;
    setInputError(problem);
    if (id && !problem) explorer.open(id);
  };
  const refresh = () => (flow ? reload() : flows.reload());
  const busy = flow ? explorer.loading : flows.loading;
  const error = flow || root ? explorer.error : flows.error;
  const retry = root ? reload : flows.reload;

  return (
    <div>
      <PageHeader
        title="Job Flows"
        description="Parents and the children they wait for: find a flow that is stuck, and release it."
        actions={
          <Button size="sm" disabled={busy} onClick={refresh}>
            Refresh
          </Button>
        }
      />
      <FlowSearch input={input} error={inputError} onInput={setInput} onSubmit={submit} />
      <div aria-live="polite">
        {error &&
          (isFlowConnectionFailure(error) ? (
            <OfflineBanner message={`Could not load flows — ${error.message}`} onRetry={retry} />
          ) : (
            <ErrorState error={error} onRetry={retry} />
          ))}
        {busy && !flow && <LoadingState label={root ? 'Loading flow…' : 'Loading flows…'} />}
      </div>
      {flow && (
        <FlowExplorer
          key={flow.root}
          explorer={explorer}
          flow={flow}
          pending={actions.pending}
          notice={actions.notice}
          onAction={(body) => void actions.run(body)}
          onDismissNotice={actions.dismiss}
        />
      )}
      {!root && flows.list && !flows.error && (
        <FlowList
          list={flows.list}
          page={flows.page}
          onPage={flows.setPage}
          onOpen={(id) => explorer.open(id)}
        />
      )}
    </div>
  );
}
