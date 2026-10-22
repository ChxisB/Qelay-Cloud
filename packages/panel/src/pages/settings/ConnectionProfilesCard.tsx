import { useState } from 'react';
import { Banner } from '@/components/ui/Banner';
import { Button, IconButton } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, FieldAction, FormRow, Input, Select } from '@/components/ui/form';
import { IconEye } from '@/components/ui/icons';
import { useConnectionProfileEditor } from './useConnectionProfileEditor';

function SecretField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="relative">
        <Input
          id={id}
          name={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="pr-10"
          autoComplete="off"
          spellCheck={false}
        />
        <IconButton
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute right-0.5 top-1/2 -translate-y-1/2"
          onClick={() => setVisible((current) => !current)}
        >
          <IconEye className="size-4" />
        </IconButton>
      </div>
    </Field>
  );
}

export function ConnectionProfilesCard() {
  const editor = useConnectionProfileEditor();
  const change = (setter: (value: string) => void) => (value: string) => {
    editor.edit();
    setter(value);
  };

  return (
    <Card>
      <CardHeader title="Fleet connections" />
      <div className="flex flex-col gap-4">
        <FormRow>
          <div className="min-w-56 flex-1">
            <Field label="Active node">
              <Select
                aria-label="Active node"
                value={editor.activeProfileId}
                onChange={(event) => editor.activateProfile(event.target.value)}
              >
                {editor.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <FieldAction>
            <Button onClick={editor.add}>Add node</Button>
          </FieldAction>
          <FieldAction>
            <Button
              variant="danger"
              disabled={editor.profiles.length === 1}
              onClick={() => void editor.remove()}
            >
              Remove
            </Button>
          </FieldAction>
        </FormRow>

        <Field label="Node name">
          <Input
            name="profile-name"
            value={editor.name}
            onChange={(event) => change(editor.setName)(event.target.value)}
            maxLength={64}
            autoComplete="off"
            placeholder="broker-eu-1"
          />
        </Field>
        <Field
          label="Server URL"
          hint={
            editor.urlError
              ? undefined
              : "The address of this node's server. Every queue page talks to the active node."
          }
          error={editor.urlError}
        >
          <Input
            name="server-url"
            value={editor.url}
            onChange={(event) => {
              change(editor.setUrl)(event.target.value);
            }}
            placeholder="/api or https://queue.example.com"
            autoComplete="off"
            inputMode="url"
          />
        </Field>
        <Field
          label="Control agent URL"
          hint={
            editor.agentUrlError
              ? undefined
              : 'Optional. Turns on the controls that change things: server start and stop, settings, flows and workflows.'
          }
          error={editor.agentUrlError}
        >
          <Input
            name="agent-url"
            value={editor.agentUrl}
            onChange={(event) => change(editor.setAgentUrl)(event.target.value)}
            placeholder="/agent or https://broker.example.com/agent"
            autoComplete="off"
            inputMode="url"
          />
        </Field>
        <SecretField
          id="bearer-token"
          label="Bearer token (optional)"
          hint="The password for this server, if it has one. Kept in memory only."
          value={editor.tok}
          onChange={change(editor.setTok)}
          placeholder="only if AUTH_TOKENS is set"
        />
        <SecretField
          id="agent-token"
          label="Agent token (optional)"
          hint="The password for the control agent, if it has one. Kept in memory only."
          value={editor.agentTok}
          onChange={change(editor.setAgentTok)}
          placeholder="only if AGENT_TOKEN is set"
        />
        {editor.saveNotice && (
          <Banner tone={editor.saveNotice.ok ? 'ok' : 'warn'} title={editor.saveNotice.msg} />
        )}
        {editor.result &&
          (editor.result.ok ? (
            <Banner tone="ok" title={editor.result.msg} />
          ) : (
            <Banner tone="problem" title="The test did not pass">
              {editor.result.msg}
            </Banner>
          ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={editor.save}>
            Save
          </Button>
          <Button onClick={editor.testServer}>
            {editor.testing === 'server' ? 'Restart test' : 'Test connection'}
          </Button>
          <Button onClick={editor.testAgent}>
            {editor.testing === 'agent' ? 'Restart agent test' : 'Test agent'}
          </Button>
        </div>
        <p className="m-0 text-[13px] text-muted">
          Changing the active node points every page at that node. Node names and addresses are
          remembered; tokens are forgotten when you reload.
        </p>
      </div>
    </Card>
  );
}
