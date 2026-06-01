import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { registerHealthRoutes } from './routes/health.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerComputersRoutes } from './routes/computers.js';
import { registerScriptsRoutes } from './routes/scripts.js';

const PORT = Number(process.env.API_PORT ?? 4000);
const BIND = process.env.API_BIND ?? '0.0.0.0';

const app = Fastify({ logger: true });

await app.register(helmet);
await app.register(cors, { origin: true, credentials: true });

await registerHealthRoutes(app);
await registerEventsRoutes(app);
await registerComputersRoutes(app);
await registerScriptsRoutes(app);

app.listen({ port: PORT, host: BIND }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
