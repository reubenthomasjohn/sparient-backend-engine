-- Per-institution behavior config. Null means "all defaults" (open by default).
-- The Zod-validated shape lives in src/services/sync/syncConfig.ts.
ALTER TABLE "institutions" ADD COLUMN "sync_config" JSONB;
