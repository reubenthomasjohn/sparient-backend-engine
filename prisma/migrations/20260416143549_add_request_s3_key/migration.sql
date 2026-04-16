-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "request_s3_bucket" VARCHAR(255),
ADD COLUMN     "request_s3_key" VARCHAR(1000);
