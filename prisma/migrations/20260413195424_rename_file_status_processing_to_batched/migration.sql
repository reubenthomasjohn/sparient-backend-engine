-- Rename FileStatus enum value 'processing' to 'batched'
-- Files in 'processing' state are included in a batch and awaiting/under Connectivo remediation

ALTER TYPE "FileStatus" RENAME VALUE 'processing' TO 'batched';
