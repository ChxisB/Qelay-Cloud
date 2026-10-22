import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';
import { Field, Input, Select } from '@/components/ui/form';
import { PROVIDERS, providerById } from '@/lib/copilot/providers';

/** Provider, endpoint, model and key. The key stays in memory; see the note at the bottom. */
export function CopilotConfig({ customBaseValid }: { customBaseValid: boolean }) {
  const { config, setConfig } = useCopilotStore();
  const def = providerById(config.provider);

  const changeProvider = (id: string) => {
    const p = providerById(id);
    setConfig({
      provider: id,
      // Named providers use their code-defined endpoint. Never copy it into the
      // editable/persisted field where a stale value could later look trusted.
      baseURL: '',
      model: p?.models[0] ?? '',
    });
  };

  return (
    <div className="space-y-3 rounded-[18px] border border-line bg-surface-2 p-4">
      <Field label="Provider">
        <Select
          name="copilot-provider"
          autoComplete="off"
          value={config.provider}
          onChange={(e) => changeProvider(e.target.value)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      {def?.id === 'custom' && (
        <Field label="Base URL" htmlFor="copilot-base-url">
          <Input
            id="copilot-base-url"
            name="copilot-base-url"
            value={config.baseURL}
            onChange={(e) => setConfig({ baseURL: e.target.value })}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            inputMode="url"
            spellCheck={false}
          />
          {!customBaseValid && (
            <span className="text-xs text-warning">
              Enter a full http(s) endpoint without credentials, query, or fragment.
            </span>
          )}
        </Field>
      )}
      <Field label="Model" htmlFor="copilot-model">
        <Input
          id="copilot-model"
          name="copilot-model"
          list="copilot-models"
          value={config.model}
          onChange={(e) => setConfig({ model: e.target.value })}
          placeholder="model id"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="copilot-models">
          {(def?.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>
      <Field label="API key">
        <Input
          name="copilot-api-key"
          type="password"
          value={config.apiKey}
          onChange={(e) => setConfig({ apiKey: e.target.value })}
          placeholder="your provider API key"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <p className="text-xs text-faint">
        Chat and tool results (live queue/job data) are sent directly from your browser to the
        provider you configure.
      </p>
      <p className="text-xs text-faint">
        Key stays in memory for this session only, never saved to disk.{' '}
        {def?.keyUrl && (
          <a
            href={def.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:underline"
          >
            Get a key
          </a>
        )}
      </p>
      {def && !def.browserDirect && (
        <p className="rounded-[12px] border border-state-waiting-fg/40 bg-state-waiting-bg px-3 py-2 text-xs text-state-waiting-fg">
          {def.note ?? 'This provider may block direct browser calls (CORS).'}
        </p>
      )}
    </div>
  );
}
