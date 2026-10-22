import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { ConnectionBadge } from './ConnectionBadge';
import { UserBlock } from './UserBlock';

/**
 * Where the control agent lives, from the active connection profile. This reports the target,
 * not liveness: the agent has no cheap health route (`/control/status` probes the server and
 * takes a lifecycle lease), so the shell does not poll it. The dot is therefore neutral.
 */
function AgentLine() {
  const agentBaseUrl = useConnectionStore((s) => s.agentBaseUrl);
  const host = agentBaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return (
    <div className="flex items-center gap-2 px-1.5 text-xs text-faint" title={agentBaseUrl}>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-idle" />
      <span className="min-w-0">
        Control agent · <span className="whitespace-nowrap">{host}</span>
      </span>
    </div>
  );
}

/** Bottom of the sidebar: the health card, the agent target and the user. */
export function SidebarFooter() {
  return (
    <div className="flex shrink-0 flex-col gap-3.5 pt-3">
      <ConnectionBadge />
      <AgentLine />
      <UserBlock />
    </div>
  );
}
