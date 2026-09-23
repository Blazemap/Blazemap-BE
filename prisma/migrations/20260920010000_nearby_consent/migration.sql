CREATE TABLE "TrUserLocation" (
  "userId" TEXT PRIMARY KEY REFERENCES "MsUser"("id") ON DELETE CASCADE,
  "latitude" DOUBLE PRECISION NOT NULL CHECK ("latitude" BETWEEN -90 AND 90),
  "longitude" DOUBLE PRECISION NOT NULL CHECK ("longitude" BETWEEN -180 AND 180),
  "accuracyMeters" DOUBLE PRECISION NOT NULL CHECK ("accuracyMeters" BETWEEN 0 AND 1000),
  "capturedAt" TIMESTAMPTZ(3) NOT NULL,
  "consentAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "TrUserLocation_expiresAt_idx" ON "TrUserLocation"("expiresAt");
ALTER TABLE "TrNotification" ALTER COLUMN "reportId" DROP NOT NULL;
ALTER TABLE "TrNotification" ADD COLUMN "publicationId" TEXT REFERENCES "TrPublicInformation"("id") ON DELETE CASCADE;
ALTER TABLE "TrNotification" ADD COLUMN "caseId" TEXT REFERENCES "TrCase"("id") ON DELETE CASCADE;
CREATE INDEX "TrNotification_publicationId_idx" ON "TrNotification"("publicationId");
CREATE INDEX "TrNotification_caseId_idx" ON "TrNotification"("caseId");
