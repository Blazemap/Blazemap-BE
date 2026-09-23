BEGIN;
ALTER TABLE "TrOperationalUpdate" DROP CONSTRAINT "TrOperationalUpdate_condition_check";
ALTER TABLE "TrOperationalUpdate" ADD CONSTRAINT "TrOperationalUpdate_condition_check" CHECK (
  ("subjectType" = 'TEAM' AND "condition" IN ('AVAILABLE', 'DEPLOYED', 'UNAVAILABLE', 'UNKNOWN'))
  OR ("subjectType" = 'EQUIPMENT' AND "condition" IN ('AVAILABLE', 'IN_USE', 'DAMAGED', 'UNAVAILABLE', 'UNKNOWN'))
  OR ("subjectType" = 'FEATURE' AND "condition" IN ('PASSABLE', 'RESTRICTED', 'IMPASSABLE', 'WATER_AVAILABLE', 'WATER_UNAVAILABLE', 'AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'))
);
COMMIT;
