import { PageHeader } from '@/components/ui/PageHeader';
import { useAuthStore } from '@/lib/auth/authStore';
import { AppearanceCard } from './settings/AppearanceCard';
import { ConnectionProfilesCard } from './settings/ConnectionProfilesCard';
import { SessionCard } from './settings/SessionCard';

export { isValidBaseUrl } from '@/components/dashboard/stores/connectionStore';
export { fetchHealthWithTimeout, SETTINGS_TEST_TIMEOUT_MS } from './settings/health';

export function Settings() {
  // With an identity provider the API address and credential are not the user's to edit.
  const managed = useAuthStore((s) => s.managed);
  return (
    <div>
      <PageHeader title="Settings" description="Fleet connections, credentials and appearance." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {managed ? <SessionCard /> : <ConnectionProfilesCard />}
        <AppearanceCard />
      </div>
    </div>
  );
}
