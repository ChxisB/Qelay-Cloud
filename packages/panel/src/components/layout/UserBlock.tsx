import { iconButtonClass } from '@/components/ui/Button';
import { getActiveSession } from '@/lib/auth/activeSession';
import { useAuthStore } from '@/lib/auth/authStore';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';
import { ICON, NavIcon } from './NavIcon';

const ROLE_LABEL = { viewer: 'Viewer', operator: 'Operator' } as const;

/**
 * Who the panel is acting as: the role the server reported, and the sign-in subject when the panel
 * manages sign-in. Both are read from stores that already hold them, so no name is invented. Sign
 * out lives here and exists only for a managed, signed-in session.
 */
export function UserBlock() {
  const role = ROLE_LABEL[useCapabilities().caps.principal.role];
  const signedIn = useAuthStore((s) => s.managed && s.status === 'ready');
  const subject = useAuthStore((s) => (s.managed && s.status === 'ready' ? s.subject : null));
  const name = subject ?? role;
  const initials = (name.match(/[a-z0-9]/gi) ?? ['?']).slice(0, 2).join('').toUpperCase();

  return (
    <div className="flex min-h-8 items-center gap-2 px-1.5 font-semibold">
      <span
        aria-hidden="true"
        className="inline-grid size-7 shrink-0 place-items-center rounded-full bg-ok text-xs font-bold text-on-ok"
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1 text-sm" title={subject ?? undefined}>
        <span className="block truncate">{name}</span>
        {subject && <span className="block text-xs font-medium text-faint">{role}</span>}
      </span>
      {signedIn && (
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => void getActiveSession()?.signOut()}
          className={iconButtonClass('ghost', 'sm')}
        >
          <NavIcon d={ICON.signOut} className="size-4" />
        </button>
      )}
    </div>
  );
}
