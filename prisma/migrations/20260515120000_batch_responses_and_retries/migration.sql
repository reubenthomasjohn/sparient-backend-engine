-- Track follow-up responses (Connectivo retries low-quality files on its own).
ALTER TABLE "batches" ADD COLUMN "num_retries" INTEGER NOT NULL DEFAULT 0;

-- One row per response.json. Unique s3_key gives us SQS-redelivery dedup.
CREATE TABLE "batch_responses" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "s3_key" VARCHAR(1000) NOT NULL,
    "connectivo_batch_id" VARCHAR(255),
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_responses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "batch_responses_s3_key_key" ON "batch_responses"("s3_key");
CREATE INDEX "batch_responses_batch_id_idx" ON "batch_responses"("batch_id");

ALTER TABLE "batch_responses" ADD CONSTRAINT "batch_responses_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: synthetic batch_responses row for every batch already in a terminal
-- status. Without this, a Connectivo retry response for such a batch would see
-- responseCount=1 (from inserting the retry's row), be treated as the FIRST
-- response, and mark every file absent from the retry as failed — corrupting
-- the already-completed file outcomes. The "legacy:" s3_key prefix is a sentinel
-- guaranteed not to collide with real S3 object keys.
INSERT INTO "batch_responses" ("id", "batch_id", "s3_key", "connectivo_batch_id", "processed_at")
SELECT
    gen_random_uuid()::text,
    "id",
    'legacy:' || "id",
    "connectivo_batch_id",
    COALESCE("completed_at", "updated_at", "created_at")
FROM "batches"
WHERE "status" IN ('completed', 'completed_with_warnings', 'failed', 'cancelled');
