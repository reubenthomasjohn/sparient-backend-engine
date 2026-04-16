-- Drop the API key table — auth no longer applies (Connectivo uses S3 buckets, not REST).
DROP TABLE "connectivo_api_keys";

-- Replace acknowledged_at with request_written_at (we no longer get an explicit ack;
-- we record when we wrote the request to S3 instead).
ALTER TABLE "batches" DROP COLUMN "acknowledged_at";
ALTER TABLE "batches" ADD COLUMN "request_written_at" TIMESTAMP(3);

-- Remove the now-unused 'processing' value from BatchStatus. Postgres requires
-- recreating the type to drop a value.
ALTER TYPE "BatchStatus" RENAME TO "BatchStatus_old";
CREATE TYPE "BatchStatus" AS ENUM ('pending', 'completed', 'completed_with_warnings', 'failed', 'cancelled');
ALTER TABLE "batches"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "BatchStatus" USING "status"::text::"BatchStatus",
  ALTER COLUMN "status" SET DEFAULT 'pending';
DROP TYPE "BatchStatus_old";
