-- courses.total_file_count: unfiltered Canvas file count per course (all types/sizes/
-- locked/hidden), refreshed on each discovery run. Null until first discovered.
ALTER TABLE "courses" ADD COLUMN "total_file_count" INTEGER;

-- source_files.writeback_started_at: lease timestamp for the in_progress claim, so a
-- redrive can reclaim a row left in_progress by a crashed/timed-out worker.
ALTER TABLE "source_files" ADD COLUMN "writeback_started_at" TIMESTAMP(3);
