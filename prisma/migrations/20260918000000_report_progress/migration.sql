ALTER TYPE "ReviewStatus" ADD VALUE 'UNDER_REVIEW' BEFORE 'NEW';

CREATE TABLE "TrReportProgress" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrReportProgress_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrReportProgress_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TrReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrReportProgress_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TrReportProgress_reportId_createdAt_idx" ON "TrReportProgress"("reportId", "createdAt");
CREATE INDEX "TrReportProgress_actorId_idx" ON "TrReportProgress"("actorId");
