import type { ReactNode } from 'react';
import { SystemTabs } from '@/components/SystemTabs';
import { Banner } from '@/components/ui/Banner';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { CopyButton } from '@/components/ui/CopyButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard } from '@/components/ui/StatCard';
import { Tag } from '@/components/ui/Tag';
import { CLI_ADD, EMBEDDED_CONFIG, TCP_CONFIG } from './mcp/setup';

/**
 * MCP Server — a setup and reference page for qelay's Model Context Protocol
 * server (`qelay-mcp`). That server is a separate stdio process that exposes
 * the queue to AI agents (Claude Desktop, Claude Code); it is NOT part of the
 * HTTP API this dashboard drives, and it is launched by the MCP client rather
 * than managed here, so this page is a guide (what it exposes + how to connect
 * it), not a live monitor. The totals below are derived from the reference
 * arrays in this module so edits cannot leave the summary cards stale.
 */

type Category = { name: string; count: number; examples: string[] };

// Every tool is prefixed `qelay_`; examples below drop the prefix for readability.
const CATEGORIES: Category[] = [
  {
    name: 'Jobs',
    count: 11,
    examples: ['add_job', 'get_job', 'get_jobs', 'get_job_result', 'wait_for_job'],
  },
  {
    name: 'Job management',
    count: 6,
    examples: ['cancel_job', 'change_job_priority', 'promote_job', 'update_job_data'],
  },
  {
    name: 'Consumption',
    count: 8,
    examples: ['pull_job', 'pull_job_batch', 'ack_job', 'fail_job', 'job_heartbeat'],
  },
  {
    name: 'Queues',
    count: 11,
    examples: ['list_queues', 'pause_queue', 'resume_queue', 'drain_queue', 'obliterate_queue'],
  },
  { name: 'Dead letter queue', count: 4, examples: ['get_dlq', 'retry_dlq', 'purge_dlq'] },
  { name: 'Cron', count: 4, examples: ['add_cron', 'list_crons', 'get_cron', 'delete_cron'] },
  {
    name: 'Flows',
    count: 4,
    examples: ['add_flow', 'add_flow_chain', 'get_flow', 'get_children_values'],
  },
  {
    name: 'Rate limits',
    count: 4,
    examples: ['set_rate_limit', 'set_concurrency', 'clear_rate_limit'],
  },
  {
    name: 'Webhooks',
    count: 4,
    examples: ['add_webhook', 'list_webhooks', 'remove_webhook', 'set_webhook_enabled'],
  },
  {
    name: 'Workers',
    count: 3,
    examples: ['register_worker', 'unregister_worker', 'worker_heartbeat'],
  },
  {
    name: 'Handlers',
    count: 3,
    examples: ['register_handler', 'list_handlers', 'unregister_handler'],
  },
  {
    name: 'Monitoring',
    count: 11,
    examples: ['get_stats', 'get_queue_stats', 'get_memory_stats', 'get_prometheus_metrics'],
  },
];

const RESOURCES = [
  'qelay://queues',
  'qelay://stats',
  'qelay://workers',
  'qelay://crons',
  'qelay://webhooks',
];

const PROMPTS = ['qelay_debug_queue', 'qelay_health_report', 'qelay_incident_response'];
const TOOL_COUNT = CATEGORIES.reduce((sum, category) => sum + category.count, 0);

function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative min-w-0 max-w-full">
      <div className="absolute right-2 top-2 z-[1]">
        <CopyButton value={code} />
      </div>
      <CodeBlock label={label} className="max-w-full overscroll-x-contain pr-14">
        {code}
      </CodeBlock>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <Tag>
      <span className="font-mono">{children}</span>
    </Tag>
  );
}

export function McpServer() {
  return (
    <div className="min-w-0 overflow-x-hidden">
      <PageHeader
        title="MCP server"
        description="Connect qelay to AI agents (Claude Desktop, Claude Code) over the Model Context Protocol."
        actions={
          <a
            href="https://chxisb.github.io/qelay-control-panel/docs/guide/mcp"
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('default', 'sm')}
          >
            Docs
          </a>
        }
      />
      <SystemTabs current="/mcp" />

      <Card className="mb-6">
        <p className="m-0 text-[13px] leading-relaxed text-muted">
          qelay includes a server, <span className="font-mono text-fg">qelay-mcp</span>, that lets
          an AI agent manage your queues through tools, resources and prompts. The agent starts it
          on its own computer, not from this dashboard, so this page is a setup guide and not a live
          monitor. It needs one extra package,{' '}
          <span className="font-mono text-fg">@modelcontextprotocol/sdk</span>.
        </p>
      </Card>

      <div className="mb-6">
        <Banner tone="warn" title="Some tools are destructive">
          The upstream MCP includes destructive Cancel, Discard, Drain, Obliterate, DLQ Retry and
          DLQ Purge tools. They bypass this dashboard's flow-safety gates and have no atomic
          reverse-dependency or job-generation precondition. Grant MCP write access only after
          independently proving the workload is not flow-linked.
        </Banner>
      </div>

      <Card className="mb-6">
        <CardHeader title="Install the MCP runtime" />
        <p className="m-0 mb-3 text-[13px] text-muted">
          Create a dedicated directory, install both packages, then replace the absolute path in the
          client configuration below. TCP mode connects to the existing broker.
        </p>
        <Snippet
          label="Install commands"
          code={
            'mkdir qelay-mcp-runtime\ncd qelay-mcp-runtime\nbun add --exact qelay@2.9.11 @modelcontextprotocol/sdk@1.30.0'
          }
        />
        <div className="mt-4">
          <Banner tone="warn" title="Worker ID can come back as 0">
            In Qelay TCP mode, register_worker can return ID "0". Read list_workers and match the
            unique worker name and queues before sending a heartbeat or unregistering.
          </Banner>
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Tools" value={String(TOOL_COUNT)} />
        <StatCard label="Categories" value={String(CATEGORIES.length)} />
        <StatCard label="Resources" value={String(RESOURCES.length)} />
        <StatCard label="Prompts" value={String(PROMPTS.length)} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Embedded mode (default)" />
          <p className="m-0 mb-3 text-[13px] text-muted">
            Direct SQLite access, no running server. Point <Chip>DATA_PATH</Chip> at the qelay
            database file. Best for a local agent on the same machine.
          </p>
          <Snippet label="Embedded mode configuration" code={EMBEDDED_CONFIG} />
        </Card>

        <Card className="min-w-0">
          <CardHeader title="TCP mode (remote server)" />
          <p className="m-0 mb-3 text-[13px] text-muted">
            Connect to a running qelay server over its TCP protocol port (<Chip>6789</Chip>,
            distinct from the HTTP admin API on 6790). Use a <Chip>QELAY_TOKEN</Chip> if the server
            has one.
          </p>
          <Snippet label="TCP mode configuration" code={TCP_CONFIG} />
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader title="Where to put it" />
        <p className="m-0 mb-3 text-[13px] text-muted">
          Add the JSON above to your MCP client config (for Claude Desktop, its{' '}
          <span className="font-mono text-fg">claude_desktop_config.json</span>). For Claude Code,
          register it from the CLI:
        </p>
        <Snippet label="Claude Code command" code={CLI_ADD} />
      </Card>

      <Card className="mb-6">
        <CardHeader
          title="Tools"
          action={<span className="text-[13px] font-semibold text-muted">{TOOL_COUNT} total</span>}
        />
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((c) => (
            <div key={c.name}>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-bold text-fg">{c.name}</span>
                <span className="tnum text-[13px] font-semibold text-muted">{c.count}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {c.examples.map((e) => (
                  <Chip key={e}>{e}</Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="m-0 mt-4 text-[13px] text-muted">
          Every tool name is prefixed <span className="font-mono">qelay_</span> (examples above drop
          it). Counts total {TOOL_COUNT}.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Resources"
            action={
              <span className="tnum text-[13px] font-semibold text-muted">{RESOURCES.length}</span>
            }
          />
          <div className="flex flex-wrap gap-2">
            {RESOURCES.map((r) => (
              <Chip key={r}>{r}</Chip>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Prompts"
            action={
              <span className="tnum text-[13px] font-semibold text-muted">{PROMPTS.length}</span>
            }
          />
          <div className="flex flex-wrap gap-2">
            {PROMPTS.map((p) => (
              <Chip key={p}>{p}</Chip>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
