ALTER TABLE "TrAssignment"
  ADD COLUMN "acceptedAt" TIMESTAMPTZ(3),
  ADD COLUMN "startedAt" TIMESTAMPTZ(3),
  ADD COLUMN "completedAt" TIMESTAMPTZ(3),
  ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);

ALTER TABLE "TrFieldUpdate"
  ADD COLUMN "assignmentId" TEXT;

ALTER TABLE "TrFieldUpdate"
  ADD CONSTRAINT "TrFieldUpdate_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "TrAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrFieldUpdate"
  ADD CONSTRAINT "TrFieldUpdate_assignment_team_check"
  CHECK ("assignmentId" IS NULL OR "teamId" IS NOT NULL);

CREATE INDEX "TrFieldUpdate_assignmentId_idx" ON "TrFieldUpdate"("assignmentId");

ALTER TABLE "TrUserLocation"
  ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TrNotification"
  ADD COLUMN "emailRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "emailSentAt" TIMESTAMPTZ(3),
  ADD COLUMN "emailClaimedAt" TIMESTAMPTZ(3),
  ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastEmailAttemptAt" TIMESTAMPTZ(3);

CREATE INDEX "TrNotification_email_outbox_idx"
  ON "TrNotification"("emailRequested", "emailSentAt", "emailAttempts", "emailClaimedAt");

DELETE FROM "TrAssignment" WHERE id LIKE 'sample-operations-v1-assignment-%';
DELETE FROM "TrOperationalUpdate" WHERE id LIKE 'sample-operations-v1-update-%';
DELETE FROM "MsEquipment" WHERE id LIKE 'sample-operations-v1-equipment-%';
DELETE FROM "MsMapFeature" WHERE id LIKE 'sample-operations-v1-%';
DELETE FROM "MsMapLayer" WHERE id LIKE 'sample-operations-v1-layer-%';
DELETE FROM "MsTeam" WHERE id LIKE 'sample-operations-v1-team-%';
DELETE FROM "TrAuditLog" WHERE "systemActor" = 'sample-operations-v1';
