import type { Scenario } from './scenario';
import { coreScenarios } from './scenarios.core';
import { doorbellScenarios } from './scenarios.doorbell';
import { faultScenarios } from './scenarios.faults';
import { flowScenarios } from './scenarios.flows';
import { scheduleScenarios } from './scenarios.schedule';
import { workflowScenarios } from './scenarios.workflows';

/** Every scenario, in the order the suite runs them. `docs/transports.md` is generated from this list. */
export const allScenarios: readonly Scenario[] = [
  ...coreScenarios,
  ...scheduleScenarios,
  ...faultScenarios,
  ...flowScenarios,
  ...doorbellScenarios,
  ...workflowScenarios,
];
