-- AlterTable
ALTER TABLE "article" ADD COLUMN     "content_type" TEXT,
ADD COLUMN     "content_type_score" DOUBLE PRECISION,
ADD COLUMN     "extraction_fail_reason" TEXT,
ADD COLUMN     "paywall_detected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "text_content_len" INTEGER,
ADD COLUMN     "text_content_source" TEXT,
ADD COLUMN     "usable_for_overview" BOOLEAN NOT NULL DEFAULT false;
