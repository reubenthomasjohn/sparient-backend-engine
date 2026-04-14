-- Clear test data so we can add canvas_file_id as NOT NULL without a backfill.
-- Safe in dev; on a real DB with data you'd backfill from source_files first.
TRUNCATE TABLE "batch_files" CASCADE;

ALTER TABLE "batch_files" ADD COLUMN "canvas_file_id" VARCHAR(100) NOT NULL;
