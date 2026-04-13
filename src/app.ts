import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import connectivoRoutes from './api/routes/connectivo.routes';
import syncRoutes from './api/routes/sync.routes';
import batchRoutes from './api/routes/batches.routes';
import { errorHandler } from './api/middleware/errorHandler.middleware';
import { logger } from './utils/logger';

const app = express();

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
app.use('/api/v1/connectivo', connectivoRoutes);
app.use('/api/v1/sync', syncRoutes);
app.use('/api/v1/batches', batchRoutes);

// Global error handler — must be last
app.use(errorHandler);

export default app;
