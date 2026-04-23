import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import institutionRoutes from './api/routes/institutions.routes';
import syncRoutes from './api/routes/sync.routes';
import batchRoutes from './api/routes/batches.routes';
import adminRoutes from './api/routes/admin.routes';
import accessHubRoutes from './api/routes/accessHub.routes';
import { swaggerUiServe, swaggerUiHandler } from './api/swaggerSetup';
import { errorHandler } from './api/middleware/errorHandler.middleware';
import { logger } from './utils/logger';

const app = express();

// Trust the first proxy (API Gateway / ALB) so X-Forwarded-For is used for rate limiting.
app.set('trust proxy', 1);

// Security headers — skip Helmet on `/api/docs` so Swagger UI scripts/styles load (CSP).
const helmetMiddleware = helmet();
app.use((req, res, next) => {
  if (req.path === '/api/docs' || req.path.startsWith('/api/docs/')) {
    next();
  } else {
    helmetMiddleware(req, res, next);
  }
});

// Parse JSON bodies — capture rawBody for HMAC verification (TASK-12 signed auth)
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as Express.Request).rawBody = buf;
    },
  }),
);

// HTTP request logging
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
  }),
);

// Rate limiting — applied globally; tighten per-route if needed
app.use(
  rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Health check (no auth)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// OpenAPI / Swagger UI (no auth) — `serve` + `setup` must share the same mount path
app.use('/api/docs', ...swaggerUiServe, swaggerUiHandler);

// Routes
app.use('/api/v1/institutions', institutionRoutes);
app.use('/api/v1/sync', syncRoutes);
app.use('/api/v1/batches', batchRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/access-hub', accessHubRoutes);

// Global error handler — must be last
app.use(errorHandler);

export default app;
