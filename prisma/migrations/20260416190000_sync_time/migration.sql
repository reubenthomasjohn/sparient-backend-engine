-- Replace sync_interval_hours with sync_time (daily "HH:MM" UTC).
ALTER TABLE "institutions" DROP COLUMN "sync_interval_hours";
ALTER TABLE "institutions" ADD COLUMN "sync_time" VARCHAR(5) NOT NULL DEFAULT '02:00';
