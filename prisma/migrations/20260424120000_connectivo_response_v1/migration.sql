-- Rename verapdf columns to compliance (matches Connectivo's response format)
ALTER TABLE "batch_files" RENAME COLUMN "verapdf_errors" TO "compliance_errors";
ALTER TABLE "batch_files" RENAME COLUMN "verapdf_warnings" TO "compliance_warnings";

-- Add per-file issue counts (previously only on the batch summary)
ALTER TABLE "batch_files" ADD COLUMN "total_issues_found" INTEGER;
ALTER TABLE "batch_files" ADD COLUMN "total_issues_fixed" INTEGER;

-- Add issues JSON to file_issue_categories (stores individual issue details)
ALTER TABLE "file_issue_categories" ADD COLUMN "issues" JSONB NOT NULL DEFAULT '[]';

-- Add index on batch_file_id (was missing)
CREATE INDEX "file_issue_categories_batch_file_id_idx" ON "file_issue_categories"("batch_file_id");

-- Update QualityLabel enum to match Connectivo's labels
ALTER TYPE "QualityLabel" RENAME TO "QualityLabel_old";
CREATE TYPE "QualityLabel" AS ENUM ('Excellent', 'Good', 'requires_review', 'quality_failed', 'Unchanged');
ALTER TABLE "batch_files"
  ALTER COLUMN "quality_label" TYPE "QualityLabel" USING
    CASE "quality_label"::text
      WHEN 'A' THEN 'Good'
      WHEN 'AA' THEN 'Good'
      WHEN 'AAA' THEN 'Excellent'
    END::"QualityLabel";
DROP TYPE "QualityLabel_old";
