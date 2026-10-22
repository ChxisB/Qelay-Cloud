import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { LegacyRedirect } from './components/LegacyRedirect';
import { retryableLazy } from './lib/retryableLazy';
import { OverviewPro } from './pages/control/OverviewPro';
// Eager: the layout shell, the landing route ('/'), and the trivial 404 — so the
// most common first paint has no lazy-chunk flash. Every other route is split
// into its own chunk (loaded on demand) to keep the initial bundle small.
import { NotFound } from './pages/NotFound';

// Route-level code splitting. Each page becomes its own chunk fetched only when
// its route is first visited; the named-export remap adapts to React.lazy's
// default-export contract. The <Suspense> boundary lives in AppLayout (around
// <Outlet/>) so the sidebar/topbar shell never blanks during a chunk load.
const AddJob = retryableLazy(() =>
  import('./pages/control/AddJob').then((m) => ({ default: m.AddJob }))
);
const Benchmark = retryableLazy(() =>
  import('./pages/control/Benchmark').then((m) => ({ default: m.Benchmark }))
);
const BulkAddJobs = retryableLazy(() =>
  import('./pages/control/BulkAddJobs').then((m) => ({ default: m.BulkAddJobs }))
);
const CronManager = retryableLazy(() =>
  import('./pages/control/CronManager').then((m) => ({ default: m.CronManager }))
);
const Database = retryableLazy(() =>
  import('./pages/control/Database').then((m) => ({ default: m.Database }))
);
const Deployment = retryableLazy(() =>
  import('./pages/control/Deployment').then((m) => ({ default: m.Deployment }))
);
const Diagnostics = retryableLazy(() =>
  import('./pages/control/Diagnostics').then((m) => ({ default: m.Diagnostics }))
);
const DlqPro = retryableLazy(() =>
  import('./pages/control/DlqPro').then((m) => ({ default: m.DlqPro }))
);
const Flows = retryableLazy(() =>
  import('./pages/control/Flows').then((m) => ({ default: m.Flows }))
);
const JobInspector = retryableLazy(() =>
  import('./pages/control/JobInspector').then((m) => ({ default: m.JobInspector }))
);
const JobsPro = retryableLazy(() =>
  import('./pages/control/JobsPro').then((m) => ({ default: m.JobsPro }))
);
const LogsPro = retryableLazy(() =>
  import('./pages/control/LogsPro').then((m) => ({ default: m.LogsPro }))
);
const McpServer = retryableLazy(() =>
  import('./pages/control/McpServer').then((m) => ({ default: m.McpServer }))
);
const MetricsPro = retryableLazy(() =>
  import('./pages/control/MetricsPro').then((m) => ({ default: m.MetricsPro }))
);
const QueueDetailPro = retryableLazy(() =>
  import('./pages/control/QueueDetailPro').then((m) => ({ default: m.QueueDetailPro }))
);
const QueuesOverview = retryableLazy(() =>
  import('./pages/control/QueuesOverview').then((m) => ({ default: m.QueuesOverview }))
);
const S3BackupPro = retryableLazy(() =>
  import('./pages/control/S3BackupPro').then((m) => ({ default: m.S3BackupPro }))
);
const ServerControl = retryableLazy(() =>
  import('./pages/control/ServerControl').then((m) => ({ default: m.ServerControl }))
);
const Transport = retryableLazy(() =>
  import('./pages/control/Transport').then((m) => ({ default: m.Transport }))
);
const UsagePro = retryableLazy(() =>
  import('./pages/control/UsagePro').then((m) => ({ default: m.UsagePro }))
);
const Connections = retryableLazy(() =>
  import('./pages/control/gateway/Connections').then((m) => ({ default: m.Connections }))
);
const Events = retryableLazy(() =>
  import('./pages/control/gateway/Events').then((m) => ({ default: m.Events }))
);
const GatewayMetrics = retryableLazy(() =>
  import('./pages/control/gateway/Metrics').then((m) => ({ default: m.Metrics }))
);
const ConnectionPage = retryableLazy(() =>
  import('./pages/control/gateway/ConnectionPage').then((m) => ({ default: m.ConnectionPage }))
);
const CreateConnection = retryableLazy(() =>
  import('./pages/control/gateway/CreateConnection').then((m) => ({
    default: m.CreateConnection,
  }))
);
const Issues = retryableLazy(() =>
  import('./pages/control/gateway/Issues').then((m) => ({ default: m.Issues }))
);
const Destinations = retryableLazy(() =>
  import('./pages/control/gateway/Destinations').then((m) => ({ default: m.Destinations }))
);
const WorkersPro = retryableLazy(() =>
  import('./pages/control/WorkersPro').then((m) => ({ default: m.WorkersPro }))
);
const Workflows = retryableLazy(() =>
  import('./pages/control/Workflows').then((m) => ({ default: m.Workflows }))
);
const Alerts = retryableLazy(() => import('./pages/Alerts').then((m) => ({ default: m.Alerts })));
const Fleet = retryableLazy(() => import('./pages/Fleet').then((m) => ({ default: m.Fleet })));
const Settings = retryableLazy(() =>
  import('./pages/Settings').then((m) => ({ default: m.Settings }))
);

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<OverviewPro />} />
        <Route path="/fleet" element={<Fleet />} />
        <Route path="/overview-classic" element={<LegacyRedirect />} />
        <Route path="/queues" element={<QueuesOverview />} />
        <Route path="/queues-classic" element={<LegacyRedirect />} />
        <Route path="/queues/:name" element={<QueueDetailPro />} />
        <Route path="/queues-classic/:name" element={<LegacyRedirect />} />
        <Route path="/jobs" element={<JobsPro />} />
        <Route path="/jobs-classic" element={<LegacyRedirect />} />
        <Route path="/dlq" element={<DlqPro />} />
        <Route path="/dlq-classic" element={<LegacyRedirect />} />
        <Route path="/cron" element={<CronManager />} />
        <Route path="/cron-classic" element={<LegacyRedirect />} />
        <Route path="/flows" element={<Flows />} />
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/workflows/executions" element={<Navigate to="/workflows" replace />} />
        <Route
          path="/workflows/waiting"
          element={<Navigate to="/workflows?state=waiting" replace />}
        />
        <Route
          path="/workflows/compensation"
          element={<Navigate to="/workflows?state=compensation-stuck" replace />}
        />
        <Route path="/workflows/archive" element={<Navigate to="/workflows" replace />} />
        <Route path="/metrics" element={<MetricsPro />} />
        <Route path="/metrics-classic" element={<LegacyRedirect />} />
        <Route path="/workers" element={<WorkersPro />} />
        <Route path="/workers-classic" element={<LegacyRedirect />} />
        <Route path="/logs" element={<LogsPro />} />
        <Route path="/logs-classic" element={<LegacyRedirect />} />
        <Route path="/server" element={<ServerControl />} />
        <Route path="/add-job" element={<AddJob />} />
        <Route path="/jobs/bulk-add" element={<BulkAddJobs />} />
        <Route path="/job" element={<JobInspector />} />
        {/* Queue control is the Settings tab of each queue; DLQ control was a copy of the DLQ page. */}
        <Route path="/queue-control" element={<Navigate to="/queues" replace />} />
        {/* Legacy alias: CronManager graduated to /cron; redirect keeps old bookmarks alive. */}
        <Route path="/cron-manager" element={<Navigate to="/cron" replace />} />
        <Route path="/dlq-control" element={<Navigate to="/dlq" replace />} />
        {/* Webhooks are connections of the Event gateway; old links and bookmarks land on its first screen. */}
        <Route path="/events-gateway" element={<Connections />} />
        <Route path="/events-gateway/events" element={<Events />} />
        <Route path="/events-gateway/metrics" element={<GatewayMetrics />} />
        <Route path="/events-gateway/issues" element={<Issues />} />
        <Route path="/events-gateway/destinations" element={<Destinations />} />
        <Route path="/events-gateway/connections/new" element={<CreateConnection />} />
        <Route path="/events-gateway/connections/:id" element={<ConnectionPage tab="overview" />} />
        <Route
          path="/events-gateway/connections/:id/metrics"
          element={<ConnectionPage tab="metrics" />}
        />
        <Route
          path="/events-gateway/connections/:id/settings"
          element={<ConnectionPage tab="settings" />}
        />
        <Route path="/webhooks" element={<Navigate to="/events-gateway" replace />} />
        <Route path="/webhooks/:id" element={<Navigate to="/events-gateway" replace />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/transport" element={<Transport />} />
        <Route path="/deployment" element={<Deployment />} />
        <Route path="/benchmark" element={<Benchmark />} />
        <Route path="/database" element={<Database />} />
        <Route path="/mcp" element={<McpServer />} />
        <Route path="/usage" element={<UsagePro />} />
        <Route path="/usage-classic" element={<LegacyRedirect />} />
        <Route path="/s3" element={<S3BackupPro />} />
        <Route path="/s3-classic" element={<LegacyRedirect />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
