import fs from 'fs';
import path from 'path';
import type { RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';

/**
 * Load OpenAPI document from `docs/openapi.json` (project root).
 * Resolves from `src/api` in dev and `dist/api` after `tsc` build.
 */
function loadOpenApiSpec(): Record<string, unknown> {
  const fromModule = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
  if (fs.existsSync(fromModule)) {
    return JSON.parse(fs.readFileSync(fromModule, 'utf8')) as Record<string, unknown>;
  }
  const fromCwd = path.join(process.cwd(), 'docs', 'openapi.json');
  if (fs.existsSync(fromCwd)) {
    return JSON.parse(fs.readFileSync(fromCwd, 'utf8')) as Record<string, unknown>;
  }
  throw new Error(
    'OpenAPI spec not found. Expected docs/openapi.json at project root.',
  );
}

const spec = loadOpenApiSpec();

export const swaggerUiServe: RequestHandler[] = swaggerUi.serve;
export const swaggerUiHandler: RequestHandler = swaggerUi.setup(spec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Sparient API',
  swaggerOptions: {
    persistAuthorization: true,
    docExpansion: 'list',
    filter: true,
    tryItOutEnabled: true,
  },
});
