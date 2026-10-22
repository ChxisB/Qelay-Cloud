import { useConfirmStore } from '../src/components/dashboard/stores/confirmStore';
import { useGlobalModalStore } from '../src/components/dashboard/stores/globalModalStore';

/**
 * Answers every question the page asks in its own dialog (`confirmInPage`) the moment it is asked, as
 * `window.confirm = () => true` once did. `questions` lists what was asked, in order, and `details` holds each
 * question's detail text at the same index; `stop()` ends it.
 * The dialog itself is mounted by the shell, so a test that wants the real buttons mounts `ConfirmDialog`.
 */
export function answerConfirms(answer = true) {
  useConfirmStore.setState({ current: null, queue: [] });
  useGlobalModalStore.getState().reset();
  const questions: Array<{ question: string; confirmLabel: string; danger?: boolean }> = [];
  const details: string[] = [];
  let last = 0;
  const stop = useConfirmStore.subscribe((state) => {
    const open = state.current;
    if (!open || open.id === last) return;
    last = open.id;
    questions.push({
      question: open.question,
      confirmLabel: open.confirmLabel,
      danger: open.danger,
    });
    details.push(open.detail ?? '');
    queueMicrotask(() => useConfirmStore.getState().answer(open.id, answer));
  });
  return { questions, details, stop };
}
