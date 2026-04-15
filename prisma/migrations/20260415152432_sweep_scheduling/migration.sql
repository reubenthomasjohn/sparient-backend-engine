-- AlterTable
ALTER TABLE "institutions" ADD COLUMN     "last_synced_at" TIMESTAMP(3),
ADD COLUMN     "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sync_interval_hours" INTEGER NOT NULL DEFAULT 24;
