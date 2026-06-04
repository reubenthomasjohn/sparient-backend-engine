-- CreateTable
CREATE TABLE "videos" (
    "video_id" SERIAL NOT NULL,
    "video_url" VARCHAR(500) NOT NULL,
    "video_title" VARCHAR(255) NOT NULL,
    "duration_seconds" INTEGER,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("video_id")
);

-- CreateTable
CREATE TABLE "error_keywords" (
    "id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "keyword" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "videos_video_url_key" ON "videos"("video_url");

-- CreateIndex
CREATE UNIQUE INDEX "error_keywords_video_id_keyword_key" ON "error_keywords"("video_id", "keyword");

-- Functional index for case-insensitive keyword lookups. Callers should query
-- with `LOWER(keyword) = LOWER($1)` to hit this index.
CREATE INDEX "error_keywords_keyword_lower_idx" ON "error_keywords" (LOWER("keyword"));

-- AddForeignKey
ALTER TABLE "error_keywords" ADD CONSTRAINT "error_keywords_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("video_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Auto-bump videos.updated_at on UPDATE. Needed because rows are populated/edited
-- manually via SQL, not through Prisma (which would handle this via @updatedAt).
CREATE OR REPLACE FUNCTION set_videos_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER videos_updated_at_trigger
BEFORE UPDATE ON "videos"
FOR EACH ROW
EXECUTE FUNCTION set_videos_updated_at();
