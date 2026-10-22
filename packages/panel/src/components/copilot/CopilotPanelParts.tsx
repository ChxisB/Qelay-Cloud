import type {
  ChatMessage,
  PendingConfirm,
  ToolEvent,
} from '@/components/dashboard/stores/copilotStore';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

const STATUS_STYLE: Record<ToolEvent['status'], string> = {
  awaiting: 'border-warning/40 text-warning',
  running: 'border-link/40 text-link',
  done: 'border-success/40 text-success',
  error: 'border-danger/40 text-danger',
  declined: 'border-line text-faint',
};

export function PanelIconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active ?? undefined}
      onClick={onClick}
      className={iconButtonClass(active ? 'default' : 'ghost', 'sm')}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-[18px]"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] space-y-2 rounded-[20px] px-4 py-3',
          isUser
            ? 'rounded-br-[6px] bg-primary text-primary-fg'
            : 'w-full rounded-bl-[6px] bg-slate-tint'
        )}
      >
        {(message.tools?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.tools?.map((tool) => (
              <span
                key={tool.id}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border bg-surface px-2.5 py-0.5 text-[12px] font-semibold',
                  STATUS_STYLE[tool.status]
                )}
                title={tool.error || (tool.mutates ? 'mutating action' : 'read')}
              >
                {tool.mutates && <span aria-hidden="true">●</span>}
                {tool.label}
                {tool.status === 'declined' && ' (declined)'}
                {tool.status === 'error' && ' (failed)'}
              </span>
            ))}
          </div>
        )}
        {message.content && (
          <div
            className={cn(
              'whitespace-pre-wrap break-words text-sm',
              message.error ? 'text-danger' : isUser ? 'text-primary-fg' : 'text-fg'
            )}
          >
            {message.content}
          </div>
        )}
        {!message.content && !isUser && (message.tools?.length ?? 0) === 0 && (
          <div className="text-sm text-faint">{message.done ? 'Stopped.' : 'Thinking…'}</div>
        )}
      </div>
    </div>
  );
}

export function ConfirmCard({
  confirm,
  onConfirm,
  onDecline,
}: {
  confirm: PendingConfirm;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const args = confirm.args as Record<string, unknown> | undefined;
  return (
    <div className="rounded-[18px] border border-state-waiting-fg/40 bg-state-waiting-bg px-4 py-3">
      <div className="text-sm font-bold text-fg">Confirm: {confirm.label}</div>
      {args && Object.keys(args).length > 0 && (
        <div className="mt-1 font-mono text-xs text-muted">
          {Object.entries(args)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join('  ·  ')}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={onConfirm}>
          Confirm
        </Button>
        <Button size="sm" onClick={onDecline}>
          Decline
        </Button>
      </div>
    </div>
  );
}
