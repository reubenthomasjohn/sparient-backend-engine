-- review_acknowledged is a per-cycle UI flag, so it belongs on batch_files.
-- The previous column on source_files would have carried stale acks across new
-- remediation cycles. No data preservation needed — the column was unused.
ALTER TABLE "source_files" DROP COLUMN "review_acknowledged";
ALTER TABLE "batch_files" ADD COLUMN "review_acknowledged" BOOLEAN NOT NULL DEFAULT false;

-- Drives the "to review" UI query: WHERE quality_label = 'requires_review' AND review_acknowledged = false.
-- For prod with a populated batch_files table this will need to be re-issued
-- as CREATE INDEX CONCURRENTLY (see docs/TODO.md). At dev scale the brief lock is fine.
CREATE INDEX "batch_files_quality_label_review_acknowledged_idx"
  ON "batch_files" ("quality_label", "review_acknowledged");
