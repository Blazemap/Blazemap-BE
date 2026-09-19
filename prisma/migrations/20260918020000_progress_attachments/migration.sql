ALTER TABLE "TrReportProgress" ADD COLUMN "idempotencyKey" TEXT, ADD COLUMN "payloadHash" TEXT;
ALTER TABLE "TrAttachment" ADD COLUMN "reportProgressId" TEXT;
CREATE UNIQUE INDEX "TrReportProgress_actorId_idempotencyKey_key" ON "TrReportProgress"("actorId", "idempotencyKey");
CREATE INDEX "TrAttachment_reportProgressId_idx" ON "TrAttachment"("reportProgressId");
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_reportProgressId_fkey" FOREIGN KEY ("reportProgressId") REFERENCES "TrReportProgress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
