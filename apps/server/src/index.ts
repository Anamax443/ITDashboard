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
import { registerFrontendRoutes } from './routes/frontend.js';
import { startChecksSchedule } from './services/checks-runner.js';
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
await registerFrontendRoutes(app);

app.listen({ port: PORT, host: BIND }).then(async () => {
  await refreshIpGuard('boot');
  await startChecksSchedule();
  await startRetentionSchedule();
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
