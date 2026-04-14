-- Remove sync_enabled from institutions and courses.
-- Active-term filtering via Canvas enrollment terms replaces the need for this flag.

ALTER TABLE "institutions" DROP COLUMN "sync_enabled";
ALTER TABLE "courses" DROP COLUMN "sync_enabled";
