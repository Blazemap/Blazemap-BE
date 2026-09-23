ALTER TABLE "TrPublicInformation" ADD COLUMN "bodyRich" JSONB;
ALTER TABLE "TrPublicInformation" ADD COLUMN "caseDraftKey" TEXT;
ALTER TABLE "TrCase" ADD COLUMN "completionFieldUpdateId" TEXT;

CREATE UNIQUE INDEX "TrPublicInformation_caseDraftKey_key" ON "TrPublicInformation"("caseDraftKey");
CREATE INDEX "TrCase_completionFieldUpdateId_idx" ON "TrCase"("completionFieldUpdateId");

ALTER TABLE "TrCase" ADD CONSTRAINT "TrCase_completionFieldUpdateId_fkey" FOREIGN KEY ("completionFieldUpdateId") REFERENCES "TrFieldUpdate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
