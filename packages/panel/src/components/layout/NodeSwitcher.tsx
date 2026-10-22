import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { ICON, NavIcon } from './NavIcon';

/**
 * The design's namespace switcher, which here switches the connection profile. A native select sits
 * invisibly over the pill, so the keyboard, the screen reader and the platform picker all keep
 * working; the pill only draws the active profile.
 */
export function NodeSwitcher() {
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const activateProfile = useConnectionStore((s) => s.activateProfile);
  const active = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const name = active?.name ?? 'Local';

  return (
    <div className="relative flex min-h-8 w-full items-center gap-2 rounded-control border border-line-strong py-0 pr-2.5 pl-1 text-sm font-semibold text-fg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-control bg-ok text-xs font-bold text-on-ok"
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <NavIcon d={ICON.chevronDown} className="size-4 text-muted" />
      <label className="sr-only" htmlFor="active-node">
        Active node
      </label>
      <select
        id="active-node"
        aria-label="Active node"
        value={activeProfileId}
        onChange={(event) => activateProfile(event.target.value)}
        title={`${profiles.length} configured node${profiles.length === 1 ? '' : 's'} · ${baseUrl}`}
        className="absolute inset-0 size-full cursor-pointer appearance-none rounded-control opacity-0 outline-none"
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </div>
  );
}
