import { Button } from '@/components/ui/Button';
import { Field, FieldAction, FormRow, Select } from '@/components/ui/form';
import type { WorkflowStateFilter } from '../domain/workflowUrlState';
import { WORKFLOW_STATES } from '../domain/workflowWire';

interface Props {
  names: readonly string[];
  workflowName: string;
  state: WorkflowStateFilter | '';
  onChange: (workflowName: string, state: WorkflowStateFilter | '') => void;
}

/** Narrows the executions to one workflow, one state, or both. */
export function WorkflowFilters({ names, workflowName, state, onChange }: Props) {
  // A name from an address the list does not know is still shown: it is what the list is filtered by.
  const options = workflowName && !names.includes(workflowName) ? [workflowName, ...names] : names;
  return (
    <FormRow className="mb-4">
      <div className="min-w-[180px]">
        <Field label="Workflow">
          <Select
            name="workflow"
            value={workflowName}
            onChange={(event) => onChange(event.target.value, state)}
          >
            <option value="">All workflows</option>
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="min-w-[180px]">
        <Field label="State">
          <Select
            name="state"
            value={state}
            onChange={(event) =>
              onChange(workflowName, event.target.value as WorkflowStateFilter | '')
            }
          >
            <option value="">All states</option>
            {WORKFLOW_STATES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {(workflowName || state) && (
        <FieldAction>
          <Button size="sm" variant="ghost" onClick={() => onChange('', '')}>
            Clear filters
          </Button>
        </FieldAction>
      )}
    </FormRow>
  );
}
