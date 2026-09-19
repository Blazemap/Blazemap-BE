ALTER TYPE "ReviewStatus" ADD VALUE 'DECLINED' AFTER 'REVIEWED';
CREATE TYPE "PublicationOutcome" AS ENUM ('CONFIRMED', 'DECLINED');
ALTER TABLE "TrPublicInformation" ADD COLUMN "outcome" "PublicationOutcome", ADD COLUMN "reportId" TEXT;
ALTER TABLE "TrPublicInformation" ADD CONSTRAINT "TrPublicInformation_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TrReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "TrPublicInformation_reportId_idx" ON "TrPublicInformation"("reportId");
