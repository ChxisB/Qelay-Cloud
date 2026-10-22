import { create } from 'zustand';
import { useGlobalModalStore } from './globalModalStore';

export interface ConfirmOptions {
  /** The question, as the browser box asked it. It is the dialog's name. */
  question: string;
  /** What the main button does, as a verb: "Remove destination". */
  confirmLabel: string;
  /** Only where the caller already has more to say. */
  detail?: string;
  /** A removal: the main button is red. */
  danger?: boolean;
  /** A word to type before the main button turns on. */
  typedWord?: string;
}

export interface PendingConfirm extends ConfirmOptions {
  id: number;
  /** What had focus when the question was asked; it gets focus back. */
  opener: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  current: PendingConfirm | null;
  queue: PendingConfirm[];
  /** Settles one question. The next one waits behind it and takes its place without the shell being released. */
  answer: (id: number, confirmed: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  queue: [],
  answer(id, confirmed) {
    const { current, queue } = get();
    if (current?.id !== id) return;
    current.resolve(confirmed);
    const [next = null, ...rest] = queue;
    set({ current: next, queue: rest });
    if (!next) useGlobalModalStore.getState().release('confirm');
  },
}));

let lastId = 0;

/**
 * Asks in the page, where `window.confirm` asked in a grey system box. Resolves true on the main button and
 * false on Cancel, Escape and the dimmed area. Two questions queue and never stack. While sign-in is up
 * nothing else may open, so the answer is false and the action is not taken.
 */
export function confirmInPage(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { current, queue } = useConfirmStore.getState();
    const active = document.activeElement;
    const item: PendingConfirm = {
      ...options,
      id: ++lastId,
      // A queued question is asked from inside the open one: focus goes back to where that one started.
      opener: current ? current.opener : active instanceof window.HTMLElement ? active : null,
      resolve,
    };
    if (current) useConfirmStore.setState({ queue: [...queue, item] });
    else if (useGlobalModalStore.getState().request('confirm')) {
      useConfirmStore.setState({ current: item });
    } else resolve(false);
  });
}
