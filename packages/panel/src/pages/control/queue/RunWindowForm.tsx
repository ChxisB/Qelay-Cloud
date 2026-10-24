import { useState } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Facts } from '@/components/ui/Facts';
import { Field, FieldAction, FormRow, Input } from '@/components/ui/form';
import { ReadFirstCard, Value } from '@/components/ui/ReadFirstCard';
import { bq } from '@/lib/bq';
import type { QueueRunWindow } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { formatDateTime } from '@/lib/format';
import { assertConfigMutationResponse, configSig } from './configModel';
import { useSyncedConfig } from './configState';
import { spell, type WindowDraft, windowDraft, windowPayload } from './queueSettingModel';
import { useSettingSave } from './useSettingSave';

const TITLE = 'Run window';
const SUB = 'When workers may start jobs on this queue. Outside it, jobs wait.';
const NONE = 'No window. Workers may start jobs on this queue at any time.';

/** Where the window stands: a word and a glyph, never colour alone. */
function Standing({ window }: { window: QueueRunWindow }) {
  return window.open ? (
    <>
      <Value>
        <span className="whitespace-nowrap">
          <span aria-hidden="true">● </span>Open now
        </span>
      </Value>
      , until {formatDateTime(window.closesAt)}.
    </>
  ) : (
    <>
      <Value>
        <span className="whitespace-nowrap">
          <span aria-hidden="true">○ </span>Closed
        </span>
      </Value>
      , opens {formatDateTime(window.opensAt)}.
    </>
  );
}

function Sentence({ window }: { window: QueueRunWindow | null }) {
  if (!window) return <>{NONE}</>;
  return (
    <>
      Workers start jobs for <Value>{spell(window.durationMs)}</Value> after each{' '}
      <Value>{window.cron}</Value> ({window.timezone}). <Standing window={window} />
    </>
  );
}

const FACTS = [
  { label: 'When it closes', value: 'Running jobs finish; the rest wait for the next opening' },
  { label: 'Opening', value: 'Up to about a minute after the time' },
  { label: 'Older workers', value: 'Workers on an earlier release start jobs at any time' },
];

/** The same facts for someone who may not change them. */
function WindowFacts({ window }: { window: QueueRunWindow | null }) {
  return (
    <Card>
      <CardHeader title={TITLE} sub={SUB} />
      <p className="text-[13px] leading-6 text-muted">
        <Sentence window={window} />
      </p>
    </Card>
  );
}

/** The queue's run window. An operator sets or removes it here; a viewer reads it. */
export function RunWindowForm({
  queue,
  window,
  onSaved,
}: {
  queue: string;
  window: QueueRunWindow | null;
  onSaved: () => void | Promise<void>;
}) {
  const canOperate = useCanOperate();
  const [draft, setDraft, beginSave] = useSyncedConfig<WindowDraft>(windowDraft(window));
  const [open, setOpen] = useState(false);
  const { save, error, run } = useSettingSave(`run-window:${queue}`);
  if (!canOperate) return <WindowFacts window={window} />;

  const payload = windowPayload(draft);
  const unchanged = configSig(draft) === configSig(windowDraft(window));
  const submit = async () => {
    if (!payload.ok || unchanged) return;
    const saved = await run(async () => {
      const markSaved = beginSave();
      assertConfigMutationResponse(await bq.setRunWindow(queue, payload.value), '/run-window');
      markSaved(draft);
    }, onSaved);
    if (saved) setOpen(false);
  };
  const remove = async () => {
    const sure = await confirmInPage({
      question: `Let workers start jobs on "${queue}" at any time?`,
      confirmLabel: 'Remove window',
      detail: 'Jobs that are waiting start at the next tick.',
    });
    if (!sure) return;
    const saved = await run(async () => {
      const markSaved = beginSave();
      assertConfigMutationResponse(await bq.clearRunWindow(queue), '/run-window');
      markSaved(windowDraft(null));
    }, onSaved);
    if (saved) setOpen(false);
  };
  const set = (patch: Partial<WindowDraft>) => setDraft({ ...draft, ...patch });

  return (
    <ReadFirstCard
      title={TITLE}
      sub={SUB}
      open={open}
      onOpenChange={setOpen}
      summary={
        <>
          <Sentence window={window} />
          {save.saved && <span className="ml-2 font-semibold text-success">Saved ✓</span>}
        </>
      }
      facts={<Facts items={FACTS} />}
    >
      <FormRow>
        <div className="min-w-48 flex-1">
          <Field label="Opens at (cron)" hint="For example 0 0 * * * for midnight every night.">
            <Input
              name="run-window-cron"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={draft.cron}
              onChange={(event) => set({ cron: event.target.value })}
            />
          </Field>
        </div>
        <div className="min-w-40 flex-1">
          <Field label="Open for (hours)" hint="Part hours work: 0.5 is 30 minutes. Up to 168.">
            <Input
              name="run-window-hours"
              autoComplete="off"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={draft.hours}
              onChange={(event) => set({ hours: event.target.value })}
            />
          </Field>
        </div>
        <div className="min-w-48 flex-1">
          <Field label="Time zone" hint="For example Europe/London. Blank means UTC.">
            <Input
              name="run-window-timezone"
              autoComplete="off"
              spellCheck={false}
              value={draft.timezone}
              onChange={(event) => set({ timezone: event.target.value })}
            />
          </Field>
        </div>
        <FieldAction>
          <Button
            variant="primary"
            disabled={save.saving || !payload.ok || unchanged}
            onClick={submit}
          >
            Save
          </Button>
          {window && (
            <Button disabled={save.saving} onClick={remove}>
              Remove window
            </Button>
          )}
        </FieldAction>
      </FormRow>
      {!payload.ok && !unchanged && (
        <p role="alert" className="mt-3 text-[13px] font-semibold text-danger">
          {payload.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] font-semibold text-danger">
          {error}
        </p>
      )}
    </ReadFirstCard>
  );
}
