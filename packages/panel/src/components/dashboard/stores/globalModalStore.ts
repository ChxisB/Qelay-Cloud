import { create } from 'zustand';

/**
 * App-wide modal arbitration. Every focus-trapping surface must claim one of
 * these owners before it renders, so two independent traps can never be live
 * at the same time. Authentication is intentionally non-preemptible by normal
 * UI: a keyboard shortcut must not hide a credential challenge.
 */
export type GlobalModalOwner =
  | 'authentication'
  | 'confirm'
  | 'command-palette'
  | 'copilot'
  | 'database-row'
  | 'event-sheet'
  | 'mobile-navigation';

const PRIORITY: Record<GlobalModalOwner, number> = {
  authentication: 100,
  confirm: 90,
  'command-palette': 80,
  copilot: 60,
  'database-row': 40,
  'event-sheet': 30,
  'mobile-navigation': 20,
};

// A confirm opens over these two and gives the shell back to them. Anything else it replaces, as every owner does.
const STAYS_UNDER_CONFIRM: ReadonlySet<GlobalModalOwner> = new Set(['copilot', 'database-row']);

interface GlobalModalState {
  active: GlobalModalOwner | null;
  /** The owner a confirm sits over, which gets the shell back when it closes. */
  beneath: GlobalModalOwner | null;
  /** Returns false when a higher-priority modal currently owns the shell. */
  request: (owner: GlobalModalOwner) => boolean;
  /** Only the current owner may release the shell. */
  release: (owner: GlobalModalOwner) => void;
  reset: () => void;
}

export const useGlobalModalStore = create<GlobalModalState>((set, get) => ({
  active: null,
  beneath: null,
  request(owner) {
    const { active } = get();
    if (active === owner) return true;
    if (active && PRIORITY[active] > PRIORITY[owner]) return false;
    set({
      active: owner,
      beneath: owner === 'confirm' && active && STAYS_UNDER_CONFIRM.has(active) ? active : null,
    });
    return true;
  },
  release(owner) {
    const { active, beneath } = get();
    if (active === owner) set({ active: owner === 'confirm' ? beneath : null, beneath: null });
    // The owner under a confirm went away first: the confirm must not hand the shell back to it.
    else if (beneath === owner) set({ beneath: null });
  },
  reset() {
    set({ active: null, beneath: null });
  },
}));

/** Selector: the owner has the shell, or has it under an open confirm (it stays on screen, inert). */
export const holdsModal = (owner: GlobalModalOwner) => (state: GlobalModalState) =>
  state.active === owner || (state.active === 'confirm' && state.beneath === owner);

export function mayRestoreModalFocus(owner: GlobalModalOwner): boolean {
  const active = useGlobalModalStore.getState().active;
  return active === null || active === owner;
}
