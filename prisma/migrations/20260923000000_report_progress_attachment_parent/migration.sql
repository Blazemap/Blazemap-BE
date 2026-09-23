BEGIN;
ALTER TABLE "TrAttachment" DROP CONSTRAINT "TrAttachment_parent_check";
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_parent_check" CHECK (
  ("state" = 'ATTACHED' AND num_nonnulls("reportId", "reportProgressId", "reportUpdateId", "fieldUpdateId", "publicationId") = 1)
  OR ("state" != 'ATTACHED' AND num_nonnulls("reportId", "reportProgressId", "reportUpdateId", "fieldUpdateId", "publicationId") = 0)
);
COMMIT;
