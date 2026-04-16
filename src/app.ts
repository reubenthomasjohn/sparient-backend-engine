import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import institutionRoutes from './api/routes/institutions.routes';
import syncRoutes from './api/routes/sync.routes';
import batchRoutes from './api/routes/batches.routes';
import adminRoutes from './api/routes/admin.routes';
import { errorHandler } from './api/middleware/errorHandler.middleware';
import { logger } from './utils/logger';

const app = express();

// Trust the first proxy (API Gateway / ALB) so X-Forwarded-For is used for rate limiting.
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

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

// Routes
app.use('/api/v1/institutions', institutionRoutes);
app.use('/api/v1/sync', syncRoutes);
app.use('/api/v1/batches', batchRoutes);
app.use('/api/v1/admin', adminRoutes);

// Global error handler — must be last
app.use(errorHandler);

export default app;
