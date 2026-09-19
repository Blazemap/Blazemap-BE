CREATE TABLE "TrNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),
    CONSTRAINT "TrNotification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "MsUser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrNotification_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TrReport"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrNotification_eventKey_key" ON "TrNotification"("eventKey");
CREATE INDEX "TrNotification_userId_createdAt_id_idx" ON "TrNotification"("userId", "createdAt", "id");
CREATE INDEX "TrNotification_userId_readAt_idx" ON "TrNotification"("userId", "readAt");
CREATE INDEX "TrNotification_reportId_idx" ON "TrNotification"("reportId");
