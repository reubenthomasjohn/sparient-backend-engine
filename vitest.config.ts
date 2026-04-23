import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests under `Tests/api/**` import app and modules from `src/`
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
      S3_SOURCE_BUCKET: 'test-source',
      S3_REMEDIATED_BUCKET: 'test-remediated',
      S3_REQUESTS_BUCKET: 'test-requests',
      S3_RESPONSES_BUCKET: 'test-responses',
      ACCESS_HUB_BASIC_USER: 'hubuser',
      ACCESS_HUB_BASIC_PASSWORD: 'hubpass',
      // TASK-12 signed auth — test secrets (per-institution + global).
      // Key "11111111-..." = per-institution, "*" = global.
      ACCESS_HUB_SIGNING_SECRETS: '{"11111111-1111-1111-1111-111111111111":"per-inst-secret-xyz","*":"global-secret-abc"}',
      ACCESS_HUB_SIGNING_SKEW_SECONDS: '300',
    },
  },
});
