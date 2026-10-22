-- AlterTable
ALTER TABLE "public"."NotetakerSummary" ADD COLUMN     "formatVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "topics" JSONB NOT NULL DEFAULT '[]';
