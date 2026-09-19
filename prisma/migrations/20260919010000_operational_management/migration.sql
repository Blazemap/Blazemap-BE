ALTER TABLE "MsTeam"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "payloadHash" TEXT,
ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MsEquipment"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "payloadHash" TEXT,
ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TrAssignment"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "payloadHash" TEXT;

ALTER TABLE "TrOperationalUpdate"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "payloadHash" TEXT;

CREATE UNIQUE INDEX "MsTeam_idempotencyKey_key" ON "MsTeam"("idempotencyKey");
CREATE UNIQUE INDEX "MsEquipment_idempotencyKey_key" ON "MsEquipment"("idempotencyKey");
CREATE UNIQUE INDEX "TrAssignment_idempotencyKey_key" ON "TrAssignment"("idempotencyKey");
CREATE UNIQUE INDEX "TrOperationalUpdate_idempotencyKey_key" ON "TrOperationalUpdate"("idempotencyKey");
