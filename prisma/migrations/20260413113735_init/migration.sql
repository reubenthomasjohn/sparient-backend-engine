-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('canvas', 'sharepoint');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('pending', 'uploading_to_s3', 'ready', 'processing', 'completed', 'completed_with_warnings', 'failed', 'permanently_failed', 'deleted_from_source');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('pending', 'processing', 'completed', 'completed_with_warnings', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "QualityLabel" AS ENUM ('A', 'AA', 'AAA');

-- CreateEnum
CREATE TYPE "ConnectivoFileState" AS ENUM ('completed', 'completed_with_warnings', 'failed');

-- CreateTable
CREATE TABLE "institutions" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "source_type" "SourceType" NOT NULL,
    "credentials" JSONB NOT NULL,
    "writeback_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "institution_id" TEXT NOT NULL,
    "canvas_course_id" VARCHAR(100) NOT NULL,
    "canvas_term_id" VARCHAR(100),
    "name" VARCHAR(255) NOT NULL,
    "course_code" VARCHAR(100),
    "writeback_opt_in" BOOLEAN,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_files" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "canvas_file_id" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(500) NOT NULL,
    "file_name" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT,
    "canvas_modified_at" TIMESTAMP(3) NOT NULL,
    "last_writeback_modified_at" TIMESTAMP(3),
    "s3_source_key" VARCHAR(1000),
    "s3_source_bucket" VARCHAR(255),
    "status" "FileStatus" NOT NULL DEFAULT 'pending',
    "pending_resubmit" BOOLEAN NOT NULL DEFAULT false,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "next_retry_at" TIMESTAMP(3),
    "last_failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" TEXT NOT NULL,
    "institution_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "connectivo_batch_id" VARCHAR(255),
    "status" "BatchStatus" NOT NULL DEFAULT 'pending',
    "is_initial_sync" BOOLEAN NOT NULL DEFAULT false,
    "is_retry" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "total_files" INTEGER NOT NULL DEFAULT 0,
    "total_pages" INTEGER,
    "succeeded" INTEGER,
    "failed" INTEGER,
    "requires_review" INTEGER,
    "total_issues_found" INTEGER,
    "total_issues_fixed" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_files" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "source_file_id" TEXT NOT NULL,
    "connectivo_state" "ConnectivoFileState",
    "quality_label" "QualityLabel",
    "remediated_s3_key" VARCHAR(1000),
    "remediated_s3_bucket" VARCHAR(255),
    "total_pages" INTEGER,
    "processing_time_seconds" INTEGER,
    "verapdf_errors" INTEGER,
    "verapdf_warnings" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_issue_categories" (
    "id" TEXT NOT NULL,
    "batch_file_id" TEXT NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "found" INTEGER NOT NULL DEFAULT 0,
    "fixed" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "file_issue_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectivo_api_keys" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "key_hash" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connectivo_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "institutions_slug_key" ON "institutions"("slug");

-- CreateIndex
CREATE INDEX "courses_institution_id_idx" ON "courses"("institution_id");

-- CreateIndex
CREATE UNIQUE INDEX "courses_institution_id_canvas_course_id_key" ON "courses"("institution_id", "canvas_course_id");

-- CreateIndex
CREATE INDEX "source_files_course_id_idx" ON "source_files"("course_id");

-- CreateIndex
CREATE INDEX "source_files_status_idx" ON "source_files"("status");

-- CreateIndex
CREATE UNIQUE INDEX "source_files_course_id_canvas_file_id_key" ON "source_files"("course_id", "canvas_file_id");

-- CreateIndex
CREATE INDEX "batches_institution_id_idx" ON "batches"("institution_id");

-- CreateIndex
CREATE INDEX "batches_course_id_idx" ON "batches"("course_id");

-- CreateIndex
CREATE INDEX "batches_status_idx" ON "batches"("status");

-- CreateIndex
CREATE INDEX "batch_files_batch_id_idx" ON "batch_files"("batch_id");

-- CreateIndex
CREATE INDEX "batch_files_source_file_id_idx" ON "batch_files"("source_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "connectivo_api_keys_key_hash_key" ON "connectivo_api_keys"("key_hash");

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_files" ADD CONSTRAINT "batch_files_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_files" ADD CONSTRAINT "batch_files_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "source_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_issue_categories" ADD CONSTRAINT "file_issue_categories_batch_file_id_fkey" FOREIGN KEY ("batch_file_id") REFERENCES "batch_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
