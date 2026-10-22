import { useEffect, useRef, useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';
import { useGlobalModalStore } from '@/components/dashboard/stores/globalModalStore';
import { Button } from '@/components/ui/Button';
import { Tag } from '@/components/ui/Tag';
import { cn } from '@/lib/cn';
import { normalizeCustomProviderBaseURL } from '@/lib/copilot/providers';
import { abortActive, clearChat, sendMessage } from '@/lib/copilot/runtime';
import { CopilotConfig } from './CopilotConfig';
import { ConfirmCard, MessageBubble, PanelIconButton } from './CopilotPanelParts';

// A suggestion is a pill that may wrap onto two lines, so it is not `buttonClass` (which never wraps).
const CHIP =
  'inline-flex min-h-8 items-center rounded-[22px] border border-line-strong px-4 py-2 text-left text-[13px] font-bold leading-snug text-fg ' +
  'transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const SUGGESTIONS = [
  'Which queues are backing up right now?',
  'Show DLQ stats for every queue and what is failing.',
  'Summarize server health and worker status.',
];

export function CopilotPanel({ leaving = false }: { leaving?: boolean }) {
  const { config, messages, pending, busy, setOpen, resolveConfirm } = useCopilotStore();
  const customBaseValid =
    config.provider !== 'custom' || normalizeCustomProviderBaseURL(config.baseURL) !== null;
  const configured =
    config.apiKey.trim().length > 0 && config.model.trim().length > 0 && customBaseValid;

  const [input, setInput] = useState('');
  const [showConfig, setShowConfig] = useState(!configured);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  // Scroll to the latest message whenever new content arrives.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useGlobalModalStore.getState().active !== 'confirm') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')
      ?.focus();
  }, []);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy || !configured) return;
    setInput('');
    void sendMessage(t);
  };

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close Copilot"
        onClick={() => setOpen(false)}
        className={cn(
          'fixed inset-0 z-[55] cursor-default bg-scrim',
          leaving ? 'motion-fade-out pointer-events-none' : 'motion-fade'
        )}
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Copilot"
        className={cn(
          'fixed inset-y-0 right-0 z-[60] flex w-full max-w-[580px] flex-col border-l border-line-strong bg-surface shadow-pop',
          leaving ? 'motion-slide-out pointer-events-none' : 'motion-slide'
        )}
      >
        {/* Header */}
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-faint">
              Copilot
              <Tag>experimental</Tag>
            </div>
            <h2 className="mt-1 text-xl font-bold text-fg">Ask Qelay</h2>
            <p className="mt-0.5 text-sm text-muted">
              Reads your queues. Changes always ask first.
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <PanelIconButton
              label="Settings"
              active={showConfig}
              onClick={() => setShowConfig((v) => !v)}
            >
              <path d="M10 4a2 2 0 014 0 6 6 0 012.6 1.5 2 2 0 002.7 2.7 6 6 0 010 3.6 2 2 0 00-2.7 2.7A6 6 0 0114 18a2 2 0 01-4 0 6 6 0 01-2.6-1.5 2 2 0 00-2.7-2.7 6 6 0 010-3.6 2 2 0 002.7-2.7A6 6 0 0110 4z" />
              <circle cx="12" cy="12" r="2.5" />
            </PanelIconButton>
            <PanelIconButton
              label="Clear chat"
              onClick={async () => {
                if (
                  messages.length === 0 ||
                  (await confirmInPage({
                    question: 'Clear the entire Copilot conversation from this browser?',
                    confirmLabel: 'Clear chat',
                    danger: true,
                  }))
                ) {
                  clearChat();
                }
              }}
            >
              <path d="M6 7h12M9 7V5h6v2m-7 0v11a1 1 0 001 1h6a1 1 0 001-1V7" />
            </PanelIconButton>
            <PanelIconButton label="Close" onClick={() => setOpen(false)}>
              <path d="M6 6l12 12M18 6L6 18" />
            </PanelIconButton>
          </div>
        </header>

        {showConfig && (
          <div className="px-4 pt-5">
            <CopilotConfig customBaseValid={customBaseValid} />
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          aria-live="polite"
          className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-3"
        >
          {messages.length === 0 && (
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted">
                Ask about your queues, jobs, DLQ, workers, or crons. I read live data and can
                propose only promote and pause/resume. Every action names its target server and
                waits for your confirmation.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    type="button"
                    key={s}
                    onClick={() => submit(s)}
                    disabled={!configured}
                    className={CHIP}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {!configured && (
                <p className="text-xs font-semibold text-state-waiting-fg">
                  Set a provider, model, and API key above to start.
                </p>
              )}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>

        {/* Pending confirmations pinned above the input */}
        {pending.length > 0 && (
          <div className="space-y-3 border-t border-line px-4 py-4">
            {pending.map((p) => (
              <ConfirmCard
                key={p.id}
                confirm={p}
                onConfirm={() => resolveConfirm(p.id, true)}
                onDecline={() => resolveConfirm(p.id, false)}
              />
            ))}
          </div>
        )}

        {/* Input */}
        <div className="border-t border-line px-4 py-4">
          <div className="flex items-end gap-3">
            <textarea
              name="copilot-message"
              aria-label="Message to Copilot"
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
              rows={2}
              placeholder={configured ? 'Ask the Copilot…' : 'Add an API key in settings first'}
              disabled={!configured}
              className="min-h-12 flex-1 resize-none rounded-control border border-line-strong bg-surface px-4 py-3 text-[13px] font-medium text-fg placeholder:text-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-55"
            />
            {busy ? (
              <Button onClick={() => abortActive()}>Stop</Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => submit(input)}
                disabled={!input.trim() || !configured}
              >
                Send
              </Button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
