import { useState } from 'react';
import { type AlertRule, useAlertsStore } from '@/components/dashboard/stores/alertsStore';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, SectionTitle } from '@/components/ui/Card';
import { EmptyState, OfflineBanner } from '@/components/ui/feedback';
import { IconCheck } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  alertConnectionIdentity,
  enableNotifications,
  useAlertRuntimeStore,
} from '@/lib/useAlertEngine';
import { FiringTable, RulesTable } from './alerts/AlertTables';
import { RuleForm } from './alerts/RuleForm';

export type { AlertRuleDraft } from './alerts/model';
export { buildAlertRule, channelTargetError } from './alerts/model';
export { RuleForm } from './alerts/RuleForm';

// One list for every render the engine has nothing current to say: a new array would look like a change.
const NO_BREACHES: never[] = [];

function initialPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function Alerts() {
  const { rules, addRule, removeRule, toggleRule } = useAlertsStore();
  const runtimeBreaches = useAlertRuntimeStore((s) => s.breaching);
  const runtimeStatus = useAlertRuntimeStore((s) => s.status);
  const runtimeError = useAlertRuntimeStore((s) => s.error);
  const runtimeIdentity = useAlertRuntimeStore((s) => s.connectionIdentity);
  const connectionIdentity = useConnectionStore((s) => alertConnectionIdentity(s.baseUrl, s.token));
  const hasEnabledRules = rules.some((rule) => rule.enabled);
  // The headless engine resets in an effect. Gate its store snapshot during the
  // render that changes connection so server A's breaches never paint under B.
  const runtimeIsCurrent = runtimeIdentity === connectionIdentity;
  const breaching = runtimeIsCurrent ? runtimeBreaches : NO_BREACHES;
  const status = runtimeIsCurrent ? runtimeStatus : hasEnabledRules ? 'checking' : 'idle';
  const statusError = runtimeIsCurrent ? runtimeError : null;
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    initialPermission
  );

  // What the last change did, said in words for a screen reader as well as for the eye.
  const [note, setNote] = useState('');

  const requestPermission = async () => {
    setPermission(await enableNotifications());
  };
  const switchRule = (rule: AlertRule) => {
    toggleRule(rule.id);
    const firing = rule.enabled && breaching.some((b) => b.ruleId === rule.id);
    setNote(
      `Rule "${rule.name}" is ${rule.enabled ? 'disabled' : 'enabled'}.${firing ? ' Its triggered row leaves.' : ''}`
    );
  };
  const deleteRule = async (rule: AlertRule) => {
    const sure = await confirmInPage({
      question: `Delete alert rule "${rule.name}"?`,
      detail: 'It stops being checked straight away. To get it back you would create it again.',
      confirmLabel: 'Delete rule',
      danger: true,
    });
    if (!sure) return;
    removeRule(rule.id);
    setNote(`Deleted rule "${rule.name}".`);
  };

  return (
    <div>
      <PageHeader
        title="Alerts"
        description="Threshold rules evaluated live in your browser."
        live={hasEnabledRules && status === 'live'}
        actions={
          <>
            {permission === 'granted' ? (
              <span className="flex items-center gap-1.5 text-sm text-success">
                <IconCheck className="size-4" /> Desktop alerts on
              </span>
            ) : permission === 'unsupported' ? (
              <span className="text-sm text-muted">Notifications unsupported</span>
            ) : permission === 'denied' ? (
              <span className="text-sm text-muted">
                Desktop alerts blocked — allow notifications in browser settings
              </span>
            ) : (
              <Button size="sm" onClick={requestPermission}>
                Enable desktop notifications
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              aria-expanded={showRuleForm}
              aria-controls="alert-rule-form"
              onClick={() => setShowRuleForm((v) => !v)}
            >
              + Create alert rule
            </Button>
          </>
        }
      />

      {hasEnabledRules && status === 'checking' && (
        <p role="status" className="mb-4 text-[13px] text-muted">
          Checking alert metrics for the connected server…
        </p>
      )}
      {hasEnabledRules && status === 'degraded' && (
        <OfflineBanner
          message={
            statusError ?? 'Alert metrics are unavailable; current rule results may be stale.'
          }
        />
      )}

      <div className="mb-6">
        <Banner tone="warn" title="Alerts run in this browser">
          Rules are evaluated in this browser while a tab is open (even backgrounded), raising an
          in-app toast and — if enabled — a desktop notification. Qelay has no alerting backend, so
          email, webhook or Slack delivery still needs your own monitoring.
        </Banner>
      </div>
      {note && (
        <p role="status" className="mb-4 text-[13px] text-muted">
          {note}
        </p>
      )}

      <section className="mb-8">
        <SectionTitle>Triggered alerts</SectionTitle>
        <FiringTable
          breaches={breaching}
          empty={
            <EmptyState
              icon={<IconCheck />}
              title="No triggered alerts"
              hint={
                !hasEnabledRules
                  ? 'No enabled rules yet. Create one below.'
                  : status === 'live'
                    ? 'All enabled rules are within their thresholds.'
                    : status === 'checking'
                      ? 'Alert metrics are still being checked.'
                      : 'Alert metrics are unavailable; no all-clear result is available.'
              }
            />
          }
        />
      </section>

      <section>
        <SectionTitle>Alert rules</SectionTitle>
        {showRuleForm && (
          <div id="alert-rule-form">
            <Card className="mb-4">
              <RuleForm
                onAdd={(r) => {
                  const result = addRule(r);
                  if (result.ok) {
                    setShowRuleForm(false);
                    setNote(`Saved rule "${r.name}". It is checked straight away.`);
                  }
                  return result;
                }}
              />
            </Card>
          </div>
        )}
        <RulesTable
          rules={rules}
          onToggle={switchRule}
          onDelete={deleteRule}
          empty={
            <EmptyState
              title="No alert rules"
              hint="Create a rule to be notified when a threshold is crossed."
            />
          }
        />
      </section>
    </div>
  );
}
