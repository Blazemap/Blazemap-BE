DROP INDEX IF EXISTS "TrHotspot_caseId_idx";
ALTER TABLE "TrHotspot" DROP CONSTRAINT IF EXISTS "TrHotspot_caseId_fkey";
ALTER TABLE "TrHotspot" DROP COLUMN IF EXISTS "caseId";
