import type { ReactNode } from 'react';

/**
 * Small line drawings for an empty page, in the text colour so they follow the theme. Decorative: the
 * caller's `EmptyState` hides the whole picture from assistive technology, and the title says the same.
 */
function Drawing({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 128 80"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** A clock with a repeat arrow round it: a schedule. */
export const ClockDrawing = () => (
  <Drawing>
    <circle cx="64" cy="40" r="24" />
    <path d="M64 26v14l9 6" />
    <path d="M96 22a38 38 0 0 1 4 24M100 46l-6-6M100 46l6-6" strokeOpacity={0.55} />
    <path d="M32 58a38 38 0 0 1-4-24M28 34l6 6M28 34l-6 6" strokeOpacity={0.55} />
  </Drawing>
);

/** A bell with an arrow to a box: a message sent to an address. */
export const WebhookDrawing = () => (
  <Drawing>
    <path d="M44 22v3M35 50V37a9 9 0 0 1 18 0v13l3 4H32z" />
    <path d="M40.5 60a3.5 3.5 0 0 0 7 0" />
    <path d="M64 40h26M84 34l6 6-6 6" strokeOpacity={0.55} />
    <rect x="96" y="28" width="22" height="24" rx="4" />
  </Drawing>
);

/** One box with two below it, joined: a job with children. */
export const FlowDrawing = () => (
  <Drawing>
    <rect x="8" y="28" width="36" height="24" rx="5" />
    <rect x="84" y="8" width="36" height="24" rx="5" />
    <rect x="84" y="48" width="36" height="24" rx="5" />
    <path d="M44 40C64 40 64 20 84 20M44 40C64 40 64 60 84 60" strokeOpacity={0.55} />
  </Drawing>
);

/** An inbox with a tick: nothing waiting, nothing wrong. */
export const InboxDrawing = () => (
  <Drawing>
    <path d="M22 46l9-22h66l9 22v18a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4z" />
    <path d="M22 46h24a8 8 0 0 0 8 8h20a8 8 0 0 0 8-8h24" strokeOpacity={0.55} />
    <path d="M54 36l7 7 13-14" />
  </Drawing>
);
