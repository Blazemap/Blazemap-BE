CREATE TYPE "ObservationProvenance" AS ENUM ('FIELD_OBSERVATION', 'REVIEWED_CITIZEN_ESTIMATE', 'OPERATOR_ASSESSMENT');

ALTER TABLE "TrFieldUpdate"
  ADD COLUMN "provenance" "ObservationProvenance" NOT NULL DEFAULT 'FIELD_OBSERVATION',
  ADD COLUMN "sourceReportId" TEXT;

UPDATE "TrFieldUpdate"
SET "provenance" = 'OPERATOR_ASSESSMENT'
WHERE "source" = 'Authorized government review with operator-mapped boundary';

ALTER TABLE "TrFieldUpdate"
  ADD CONSTRAINT "TrFieldUpdate_sourceReportId_fkey"
  FOREIGN KEY ("sourceReportId") REFERENCES "TrReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrFieldUpdate"
  ADD CONSTRAINT "TrFieldUpdate_provenance_source_check"
  CHECK (
    ("provenance" IN ('FIELD_OBSERVATION', 'OPERATOR_ASSESSMENT') AND "sourceReportId" IS NULL)
    OR ("provenance" = 'REVIEWED_CITIZEN_ESTIMATE' AND "sourceReportId" IS NOT NULL)
  );

CREATE INDEX "TrFieldUpdate_sourceReportId_idx" ON "TrFieldUpdate"("sourceReportId");
