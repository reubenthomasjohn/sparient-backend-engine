-- Adds a 'queued' state so the user-driven replace endpoint can optimistically
-- mark a source_file in-flight. Lets the UI distinguish its own pending request
-- from a stale terminal state on re-replace; the writeback worker overwrites it
-- with the result (written | skipped_stale | failed).
ALTER TYPE "WritebackState" ADD VALUE 'queued';
