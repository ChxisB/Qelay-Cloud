import { type ChangeEvent, useEffect, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { SystemTabs } from '@/components/SystemTabs';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { IconPause, IconPlay } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { bq } from '@/lib/bq';
import { formatMs } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { BenchmarkConfiguration } from './benchmark/BenchmarkConfiguration';
import {
  BenchmarkQueueCounts,
  BenchmarkResults,
  BenchmarkSummary,
} from './benchmark/BenchmarkResults';
import { clampInt, DEFAULT_CONFIG, LIMITS, PRESETS, type RunConfig } from './benchmark/engine';
import {
  BENCHMARK_NUM_KEYS,
  type BenchmarkDraft,
  type BenchmarkNumKey,
  type PinnedBenchmarkTarget,
  sessionBenchmarkQueue,
  toBenchmarkConfig,
  toBenchmarkDraft,
} from './benchmark/pageModel';
import { RunHistory } from './benchmark/RunHistory';
import { useBenchmark } from './benchmark/useBenchmark';
import { useBenchmarkOperations } from './benchmark/useBenchmarkOperations';

export function Benchmark() {
  const [dedicatedQueue] = useState(sessionBenchmarkQueue);
  const [draft, setDraft] = useState<BenchmarkDraft>(() =>
    toBenchmarkDraft({ ...DEFAULT_CONFIG, queue: dedicatedQueue })
  );
  const benchmark = useBenchmark();
  const currentServer = useConnectionStore((state) => state.baseUrl);
  const [runTarget, setRunTarget] = useState<PinnedBenchmarkTarget | null>(null);

  const setField = <K extends keyof BenchmarkDraft>(key: K, value: BenchmarkDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const numberInput = (key: BenchmarkNumKey) => (event: ChangeEvent<HTMLInputElement>) =>
    setField(key, event.target.value);
  const applyPreset = (preset: Partial<RunConfig>) =>
    setDraft((current) => {
      const next: BenchmarkDraft = { ...current };
      for (const [key, value] of Object.entries(preset)) {
        (next as Record<string, unknown>)[key] = BENCHMARK_NUM_KEYS.includes(key as BenchmarkNumKey)
          ? String(value)
          : value;
      }
      return next;
    });

  const [pollQueue, setPollQueue] = useState(dedicatedQueue);
  useEffect(() => {
    const timeout = setTimeout(() => setPollQueue(draft.queue.trim() || DEFAULT_CONFIG.queue), 400);
    return () => clearTimeout(timeout);
  }, [draft.queue]);

  const pollBaseUrl = runTarget?.target.baseUrl ?? currentServer;
  const { data: counts, error: countsError } = usePolledData(
    () => (runTarget ? runTarget.client.counts(pollQueue) : bq.counts(pollQueue)),
    [pollQueue, runTarget],
    { intervalMs: 1000 }
  );
  const queueCounts = counts?.counts ?? null;
  const operations = useBenchmarkOperations({
    benchmark,
    counts: queueCounts,
    dedicatedQueue,
    draft,
    pollQueue,
    runTarget,
    setRunTarget,
  });

  const { phase, live, summary, history } = benchmark;
  const active = phase === 'running' || phase === 'draining' || phase === 'stopping';
  const shown = benchmark.runCfg ?? toBenchmarkConfig(draft);
  const shownTotal = clampInt(shown.total, 1, LIMITS.total);
  const shownWorkers = clampInt(shown.workers, 0, LIMITS.workers);
  const producePct =
    shown.mode === 'count' && (active || summary)
      ? Math.min(100, (live.pushed / shownTotal) * 100)
      : 0;
  const drainPct =
    shown.mode === 'count' && (active || summary)
      ? Math.min(100, (live.completed / shownTotal) * 100)
      : 0;
  const durationPct =
    shown.mode === 'duration'
      ? Math.min(
          100,
          (live.elapsedMs / (clampInt(shown.durationS, 1, LIMITS.durationS) * 1000)) * 100
        )
      : 0;
  // A value over its limit turns its field red and dims Run (SX6); the hint beside it already names the limit.
  const overLimit = BENCHMARK_NUM_KEYS.filter((key) => Number(draft[key]) > LIMITS[key]);
  const heading = phaseHeading(phase, shown.mode, Boolean(summary));
  const etaText = getEtaText(phase, live.etaMs);

  return (
    <div>
      <PageHeader
        title="Benchmark"
        description="Test how much work this server can handle. It adds a lot of test jobs to a queue of its own and processes them, then shows how fast that went. It never touches your real queues."
        actions={
          phase === 'stopping' ? (
            <Button variant="danger" size="sm" disabled>
              <IconPause className="size-3.5" /> Stopping…
            </Button>
          ) : active ? (
            <Button variant="danger" size="sm" onClick={benchmark.stop}>
              <IconPause className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={operations.cleaning}
              aria-disabled={overLimit.length > 0 || undefined}
              onClick={() => {
                if (overLimit.length === 0) void operations.start();
              }}
            >
              <IconPlay className="size-3.5" /> Run benchmark
            </Button>
          )
        }
      />
      <SystemTabs current="/benchmark" />

      {live.error && (
        <div className="mb-6">
          <Banner tone="problem" title="The benchmark hit an error">
            {live.error}
          </Banner>
        </div>
      )}

      <div role="group" aria-label="Presets" className="mb-6 flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className="text-[13px] font-extrabold text-fg">
          Presets
        </span>
        {Object.keys(PRESETS).map((name) => (
          <Button key={name} size="sm" disabled={active} onClick={() => applyPreset(PRESETS[name])}>
            {name}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <BenchmarkConfiguration
          draft={draft}
          active={active}
          cleaning={operations.cleaning}
          cleanResult={operations.cleanResult}
          overLimit={overLimit}
          setField={setField}
          numberInput={numberInput}
          onClean={() => void operations.cleanup()}
        />
        <BenchmarkResults
          heading={heading}
          pollBaseUrl={pollBaseUrl}
          etaText={etaText}
          shown={shown}
          shownWorkers={shownWorkers}
          producePct={producePct}
          drainPct={drainPct}
          durationPct={durationPct}
          live={live}
          summary={summary}
        />
      </div>

      <BenchmarkSummary summary={summary} />
      <BenchmarkQueueCounts
        pollQueue={pollQueue}
        pollBaseUrl={pollBaseUrl}
        pinned={Boolean(runTarget)}
        counts={queueCounts}
        error={countsError}
      />
      <RunHistory history={history} onClear={benchmark.clearHistory} />
    </div>
  );
}

function phaseHeading(phase: string, mode: RunConfig['mode'], hasSummary: boolean): string {
  if (phase === 'running') return mode === 'duration' ? 'Running…' : 'Producing…';
  if (phase === 'draining') return 'Draining…';
  if (phase === 'stopping') return 'Stopping…';
  if (phase === 'error') return 'Error';
  return hasSummary ? 'Result' : 'Ready';
}

function getEtaText(phase: string, etaMs: number | null): string {
  if ((phase === 'running' || phase === 'draining') && etaMs != null) {
    return etaMs > 0 ? `ETA ${formatMs(etaMs)}` : 'finishing…';
  }
  if (phase === 'stopped') return 'stopped early';
  if (phase === 'done') return 'complete';
  return '';
}
