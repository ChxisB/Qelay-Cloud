import { StatusPill } from '@/components/ui/StatusBadge';
import { type RouteState, STATE_WORDS } from './model';

/** A connection's state in words and colour: on, paused by the store after failures, or off by the operator. */
export const RouteStatePill = ({ state }: { state: RouteState }) => (
  <StatusPill state={state === 'active' ? 'completed' : state === 'paused' ? 'failed' : 'waiting'}>
    {STATE_WORDS[state]}
  </StatusPill>
);
