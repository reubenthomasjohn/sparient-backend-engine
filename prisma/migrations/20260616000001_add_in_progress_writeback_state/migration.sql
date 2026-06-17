-- Adds an 'in_progress' state so the writeback worker can lease-claim a source_file
-- before pushing to Canvas. Combined with writeback_started_at, this prevents concurrent
-- / duplicate SQS deliveries from double-pushing, while a stale lease (after a worker
-- crash/timeout) is reclaimable on redrive. See WritebackService.
ALTER TYPE "WritebackState" ADD VALUE 'in_progress';
