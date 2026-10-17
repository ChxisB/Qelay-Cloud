/** What a worker tells the store about a definition it serves: its graph, never its handlers. */

import type {
  WorkflowDefinitionInput,
  WorkflowGraphNode,
  WorkflowGraphStep,
} from '@qelay-cloud/core';
import type { StepDefinition, WorkflowNode } from './types';
import type { Workflow } from './workflow';

const stepOf = (def: StepDefinition): WorkflowGraphStep => ({
  name: def.name,
  retry: def.retry,
  timeout: def.timeout,
  compensates: def.compensate !== undefined,
});

function nodeOf(node: WorkflowNode): WorkflowGraphNode {
  switch (node.type) {
    case 'step':
      return { type: 'step', step: stepOf(node.def) };
    case 'branch':
      return {
        type: 'branch',
        paths: [...node.def.paths.entries()].map(([name, steps]) => ({
          name,
          steps: steps.map(stepOf),
        })),
      };
    case 'waitFor':
      return { type: 'waitFor', event: node.event, timeout: node.timeout ?? null };
    case 'parallel':
      return { type: 'parallel', steps: node.def.steps.map(stepOf) };
    case 'subWorkflow':
      return { type: 'subWorkflow', name: node.name, timeout: node.timeout };
    case 'doUntil':
    case 'doWhile':
      return {
        type: node.type,
        maxIterations: node.def.maxIterations,
        steps: node.def.steps.map(stepOf),
      };
    case 'forEach':
      return {
        type: 'forEach',
        maxIterations: node.def.maxIterations,
        step: stepOf(node.def.step),
      };
    case 'map':
      return { type: 'map', name: node.def.name };
    case 'pivot':
      return { type: 'pivot' };
  }
}

/** The definition as the store keeps it. Seals the workflow, as registration does. */
export function describeWorkflow(workflow: Workflow): WorkflowDefinitionInput {
  return {
    name: workflow.name,
    hash: workflow.seal(),
    revision: workflow.revision,
    graph: workflow.nodes.map(nodeOf),
  };
}
