import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerComputersRoutes } from './routes/computers.js';
import { registerScriptsRoutes } from './routes/scripts.js';
import { registerCollectorRoutes } from './routes/collector.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerVersionRoutes } from './routes/version.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerDisksRoutes } from './routes/disks.js';
import { registerFirewallRoutes } from './routes/firewall.js';
import { registerServicesRoutes } from './routes/services.js';
import { registerPerfEventsRoutes } from './routes/perf-events.js';
import { registerActionsRoutes } from './routes/actions.js';
import { registerRetentionRoutes } from './routes/retention.js';
import { registerAlertsRoutes } from './routes/alerts.js';
import { registerReportsRoutes } from './routes/reports.js';
import { registerPortStatusRoutes } from './routes/port-status.js';
import { registerDevicesRoutes } from './routes/devices.js';
import { registerDeviceWebProxyRoutes } from './routes/device-web-proxy.js';
import { registerPrinterSuppliesRoutes } from './routes/printer-supplies.js';
import { registerDatabaseRoutes } from './routes/database.js';
import { registerFrontendRoutes } from './routes/frontend.js';
import { startChecksSchedule } from './services/checks-runner.js';
import { startReachabilitySchedule } from './services/reachability-collector.js';
import { startPortStatusSchedule } from './services/port-status-collector.js';
import { startMikrotikSchedule } from './services/mikrotik-collector.js';
import { startPrinterSuppliesSchedule } from './services/printer-supplies-collector.js';
import { startSharedPrintersSchedule } from './services/shared-printers-collector.js';
import { startUnifiSchedule } from './services/unifi-collector.js';
import { refreshIpGuard } from './services/ip-guard.js';
import { startRetentionSchedule } from './services/retention-runner.js';

const PORT = Number(process.env.API_PORT ?? 4000);
const BIND = process.env.API_BIND ?? '0.0.0.0';

const app = Fastify({ logger: true });

await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      // The dashboard is intentionally served over internal HTTP on :4000.
      // Helmet's default CSP upgrades same-origin assets to HTTPS, which breaks
      // the browser UI until TLS termination is added in front of the API.
      'upgrade-insecure-requests': null,
    },
  },
});
await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);

await registerAuthRoutes(app);
await registerHealthRoutes(app);
await registerEventsRoutes(app);
await registerComputersRoutes(app);
await registerScriptsRoutes(app);
await registerCollectorRoutes(app);
await registerActivityRoutes(app);
await registerVersionRoutes(app);
await registerSettingsRoutes(app);
await registerDisksRoutes(app);
await registerFirewallRoutes(app);
await registerServicesRoutes(app);
await registerPerfEventsRoutes(app);
await registerActionsRoutes(app);
await registerRetentionRoutes(app);
await registerAlertsRoutes(app);
await registerReportsRoutes(app);
await registerPortStatusRoutes(app);
await registerDevicesRoutes(app);
await registerDeviceWebProxyRoutes(app);
await registerPrinterSuppliesRoutes(app);
await registerDatabaseRoutes(app);
await registerFrontendRoutes(app);

// Load the access-check whitelist BEFORE we start accepting connections, so
// there is no window right after a deploy/restart where the in-memory cache is
// still empty and every request is denied ("Access not configured"). The deploy
// restarts the service on every push to main, so this window was visible to any
// operator who happened to load the dashboard in that moment. refreshIpGuard
// catches its own errors and never throws — a firewall-query failure just leaves
// the cache empty (same as before), so awaiting it here can't block startup.
await refreshIpGuard('boot');

app.listen({ port: PORT, host: BIND }).then(async () => {
  await startChecksSchedule();
  await startReachabilitySchedule();
  await startPortStatusSchedule();
  await startMikrotikSchedule();
  await startPrinterSuppliesSchedule();
  await startSharedPrintersSchedule();
  await startUnifiSchedule();
  await startRetentionSchedule();
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
