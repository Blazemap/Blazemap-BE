-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('NEW', 'NEEDS_DETAILS', 'REVIEWED');

-- CreateEnum
CREATE TYPE "ObservationType" AS ENUM ('SMOKE', 'FLAME', 'BURNING_SMELL');

-- CreateEnum
CREATE TYPE "LocationMode" AS ENUM ('INCIDENT_ESTIMATE', 'OBSERVER_POSITION');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'CONFIRMED_FIRE', 'NOT_FIRE');

-- CreateEnum
CREATE TYPE "VerificationOutcome" AS ENUM ('CONFIRMED_FIRE', 'NOT_FIRE', 'INCONCLUSIVE', 'CORRECTION');

-- CreateEnum
CREATE TYPE "HandlingStatus" AS ENUM ('OPEN', 'CHECK_SCHEDULED', 'ON_SCENE', 'RESPONDING', 'MONITORING', 'CLOSED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'UNASSESSED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PublicationType" AS ENUM ('UPDATE', 'ANNOUNCEMENT', 'WARNING', 'EDUCATION');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PublicLocationMode" AS ENUM ('NONE', 'REGION_ONLY', 'APPROVED_INCIDENT_POINT');

-- CreateEnum
CREATE TYPE "UploadState" AS ENUM ('PENDING', 'FINALIZING', 'READY', 'ATTACHED', 'REJECTED', 'DELETING');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'OBSOLETE');

-- CreateEnum
CREATE TYPE "EvidenceLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "FieldFinding" AS ENUM ('VISIBLE_FIRE', 'SMOKE_ONLY', 'NO_INDICATION', 'INCONCLUSIVE', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "UpdateKind" AS ENUM ('CLARIFICATION', 'REQUEST', 'CORRECTION');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('TEAM', 'EQUIPMENT', 'FEATURE');

-- CreateEnum
CREATE TYPE "FeatureKind" AS ENUM ('BOUNDARY', 'FOREST', 'PEATLAND', 'SETTLEMENT', 'FACILITY', 'ROAD', 'RIVER', 'WATER_SOURCE', 'DESIGNATED_LOCATION');

-- CreateTable
CREATE TABLE "MsUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "canConfirmIncidents" BOOLEAN NOT NULL DEFAULT false,
    "canPublishInformation" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MsUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrSession" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TrSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TrAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrAuthVerification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TrAuthVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrReport" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "observationTypes" "ObservationType"[],
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locationMode" "LocationMode" NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyMeters" DOUBLE PRECISION,
    "regionId" TEXT,
    "locationDescription" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'NEW',
    "caseId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,

    CONSTRAINT "TrReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrReportUpdate" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" "Role" NOT NULL,
    "kind" "UpdateKind" NOT NULL DEFAULT 'CLARIFICATION',
    "message" TEXT NOT NULL,
    "publicToReporter" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrReportUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrHotspot" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'NASA FIRMS',
    "product" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,
    "satellite" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "acquiredAt" TIMESTAMPTZ(3) NOT NULL,
    "confidenceRaw" TEXT NOT NULL,
    "frp" DOUBLE PRECISION,
    "version" TEXT,
    "raw" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caseId" TEXT,

    CONSTRAINT "TrHotspot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrCase" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "regionId" TEXT,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "handlingStatus" "HandlingStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Priority" NOT NULL DEFAULT 'UNASSESSED',
    "priorityReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contextRevision" INTEGER NOT NULL DEFAULT 1,
    "latestAnalysisId" TEXT,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "closureReason" TEXT,

    CONSTRAINT "TrCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrFieldUpdate" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "recorderId" TEXT NOT NULL,
    "teamId" TEXT,
    "findings" "FieldFinding" NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,

    CONSTRAINT "TrFieldUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrVerification" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "decidingAdminId" TEXT NOT NULL,
    "fieldUpdateId" TEXT NOT NULL,
    "authorityReference" TEXT NOT NULL,
    "outcome" "VerificationOutcome" NOT NULL,
    "previousStatus" "VerificationStatus" NOT NULL,
    "newStatus" "VerificationStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedDecisionId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrAttachment" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "stagingKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "detectedType" TEXT,
    "size" INTEGER NOT NULL,
    "digest" TEXT,
    "uploaderId" TEXT NOT NULL,
    "state" "UploadState" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportId" TEXT,
    "reportUpdateId" TEXT,
    "fieldUpdateId" TEXT,
    "publicationId" TEXT,
    "sourceAttachmentId" TEXT,
    "publicationUseBasis" TEXT,
    "redactionReview" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TrAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MsRegion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "bmkgAdm4" TEXT,
    "timezone" TEXT NOT NULL,
    "parentId" TEXT,
    "datasetId" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MsRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MsMapLayer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FeatureKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourceDate" TIMESTAMPTZ(3) NOT NULL,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MsMapLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MsMapFeature" (
    "id" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" "FeatureKind" NOT NULL,
    "name" TEXT,
    "geometry" JSONB NOT NULL,
    "attributes" JSONB NOT NULL,
    "regionId" TEXT,

    CONSTRAINT "MsMapFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrWeatherForecast" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'BMKG',
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "validAt" TIMESTAMPTZ(3) NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "temperature" DOUBLE PRECISION,
    "humidity" DOUBLE PRECISION,
    "windSpeed" DOUBLE PRECISION,
    "windSpeedUnit" TEXT NOT NULL DEFAULT 'km/h',
    "windDirectionRaw" TEXT,
    "windFromDegrees" DOUBLE PRECISION,
    "weatherDescription" TEXT,
    "weatherDescriptionEn" TEXT,
    "raw" JSONB NOT NULL,

    CONSTRAINT "TrWeatherForecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MsTeam" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MsTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MsEquipment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "teamId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MsEquipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrAssignment" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "assigningAdminId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TrAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrOperationalUpdate" (
    "id" TEXT NOT NULL,
    "recorderId" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "teamId" TEXT,
    "equipmentId" TEXT,
    "featureId" TEXT,
    "condition" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrOperationalUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrAnalysis" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "contextRevision" INTEGER NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "evidenceLevel" "EvidenceLevel",
    "impactLevel" "EvidenceLevel",
    "suggestedPriority" "Priority",
    "model" TEXT,
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "promptVersion" TEXT,
    "ruleVersion" TEXT NOT NULL DEFAULT '1',
    "failureCode" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TrAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrPublicInformation" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" "PublicationType" NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "sources" JSONB NOT NULL,
    "caseId" TEXT,
    "authorId" TEXT NOT NULL,
    "publisherId" TEXT,
    "authorityReference" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "validUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "withdrawalReason" TEXT,
    "supersedesId" TEXT,
    "publicLocationMode" "PublicLocationMode" NOT NULL DEFAULT 'NONE',
    "publicLatitude" DOUBLE PRECISION,
    "publicLongitude" DOUBLE PRECISION,
    "publicCaseSnapshot" JSONB,
    "privacyReview" TEXT,

    CONSTRAINT "TrPublicInformation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrPublicInformationRegion" (
    "publicInformationId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,

    CONSTRAINT "TrPublicInformationRegion_pkey" PRIMARY KEY ("publicInformationId","regionId")
);

-- CreateTable
CREATE TABLE "MsSiteProfile" (
    "id" TEXT NOT NULL DEFAULT 'site',
    "name" TEXT,
    "operator" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "hours" TEXT,
    "source" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MsSiteProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrIntegrationRun" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "received" INTEGER,
    "imported" INTEGER,
    "deduplicated" INTEGER,
    "failureCode" TEXT,

    CONSTRAINT "TrIntegrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "systemActor" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MsUser_email_key" ON "MsUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TrSession_token_key" ON "TrSession"("token");

-- CreateIndex
CREATE INDEX "TrSession_userId_idx" ON "TrSession"("userId");

-- CreateIndex
CREATE INDEX "TrAccount_userId_idx" ON "TrAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrAccount_providerId_accountId_key" ON "TrAccount"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "TrAuthVerification_identifier_idx" ON "TrAuthVerification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "TrReport_number_key" ON "TrReport"("number");

-- CreateIndex
CREATE INDEX "TrReport_reporterId_createdAt_idx" ON "TrReport"("reporterId", "createdAt");

-- CreateIndex
CREATE INDEX "TrReport_caseId_observedAt_idx" ON "TrReport"("caseId", "observedAt");

-- CreateIndex
CREATE INDEX "TrReport_regionId_idx" ON "TrReport"("regionId");

-- CreateIndex
CREATE INDEX "TrReport_reviewStatus_createdAt_idx" ON "TrReport"("reviewStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrReport_reporterId_idempotencyKey_key" ON "TrReport"("reporterId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TrReportUpdate_reportId_createdAt_idx" ON "TrReportUpdate"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "TrReportUpdate_authorId_idx" ON "TrReportUpdate"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "TrHotspot_observationKey_key" ON "TrHotspot"("observationKey");

-- CreateIndex
CREATE INDEX "TrHotspot_acquiredAt_idx" ON "TrHotspot"("acquiredAt");

-- CreateIndex
CREATE INDEX "TrHotspot_caseId_idx" ON "TrHotspot"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "TrCase_number_key" ON "TrCase"("number");

-- CreateIndex
CREATE UNIQUE INDEX "TrCase_latestAnalysisId_key" ON "TrCase"("latestAnalysisId");

-- CreateIndex
CREATE INDEX "TrCase_regionId_idx" ON "TrCase"("regionId");

-- CreateIndex
CREATE INDEX "TrCase_handlingStatus_priority_updatedAt_idx" ON "TrCase"("handlingStatus", "priority", "updatedAt");

-- CreateIndex
CREATE INDEX "TrFieldUpdate_caseId_observedAt_idx" ON "TrFieldUpdate"("caseId", "observedAt");

-- CreateIndex
CREATE INDEX "TrFieldUpdate_recorderId_idx" ON "TrFieldUpdate"("recorderId");

-- CreateIndex
CREATE INDEX "TrFieldUpdate_teamId_idx" ON "TrFieldUpdate"("teamId");

-- CreateIndex
CREATE INDEX "TrVerification_caseId_createdAt_idx" ON "TrVerification"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "TrVerification_decidingAdminId_idx" ON "TrVerification"("decidingAdminId");

-- CreateIndex
CREATE INDEX "TrVerification_fieldUpdateId_idx" ON "TrVerification"("fieldUpdateId");

-- CreateIndex
CREATE INDEX "TrVerification_correctedDecisionId_idx" ON "TrVerification"("correctedDecisionId");

-- CreateIndex
CREATE UNIQUE INDEX "TrAttachment_objectKey_key" ON "TrAttachment"("objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrAttachment_stagingKey_key" ON "TrAttachment"("stagingKey");

-- CreateIndex
CREATE INDEX "TrAttachment_uploaderId_state_idx" ON "TrAttachment"("uploaderId", "state");

-- CreateIndex
CREATE INDEX "TrAttachment_reportId_idx" ON "TrAttachment"("reportId");

-- CreateIndex
CREATE INDEX "TrAttachment_reportUpdateId_idx" ON "TrAttachment"("reportUpdateId");

-- CreateIndex
CREATE INDEX "TrAttachment_fieldUpdateId_idx" ON "TrAttachment"("fieldUpdateId");

-- CreateIndex
CREATE INDEX "TrAttachment_publicationId_idx" ON "TrAttachment"("publicationId");

-- CreateIndex
CREATE INDEX "TrAttachment_sourceAttachmentId_idx" ON "TrAttachment"("sourceAttachmentId");

-- CreateIndex
CREATE INDEX "TrAttachment_approvedById_idx" ON "TrAttachment"("approvedById");

-- CreateIndex
CREATE INDEX "TrAttachment_state_expiresAt_idx" ON "TrAttachment"("state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MsRegion_code_key" ON "MsRegion"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MsRegion_bmkgAdm4_key" ON "MsRegion"("bmkgAdm4");

-- CreateIndex
CREATE INDEX "MsRegion_parentId_idx" ON "MsRegion"("parentId");

-- CreateIndex
CREATE INDEX "MsRegion_datasetId_idx" ON "MsRegion"("datasetId");

-- CreateIndex
CREATE INDEX "MsRegion_name_idx" ON "MsRegion"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MsMapLayer_provider_name_version_key" ON "MsMapLayer"("provider", "name", "version");

-- CreateIndex
CREATE INDEX "MsMapFeature_regionId_idx" ON "MsMapFeature"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "MsMapFeature_layerId_sourceId_key" ON "MsMapFeature"("layerId", "sourceId");

-- CreateIndex
CREATE INDEX "TrWeatherForecast_regionId_validAt_idx" ON "TrWeatherForecast"("regionId", "validAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrWeatherForecast_provider_regionId_issuedAt_validAt_key" ON "TrWeatherForecast"("provider", "regionId", "issuedAt", "validAt");

-- CreateIndex
CREATE INDEX "MsEquipment_teamId_idx" ON "MsEquipment"("teamId");

-- CreateIndex
CREATE INDEX "TrAssignment_caseId_status_idx" ON "TrAssignment"("caseId", "status");

-- CreateIndex
CREATE INDEX "TrAssignment_teamId_idx" ON "TrAssignment"("teamId");

-- CreateIndex
CREATE INDEX "TrAssignment_assigningAdminId_idx" ON "TrAssignment"("assigningAdminId");

-- CreateIndex
CREATE INDEX "TrOperationalUpdate_teamId_observedAt_idx" ON "TrOperationalUpdate"("teamId", "observedAt");

-- CreateIndex
CREATE INDEX "TrOperationalUpdate_equipmentId_observedAt_idx" ON "TrOperationalUpdate"("equipmentId", "observedAt");

-- CreateIndex
CREATE INDEX "TrOperationalUpdate_featureId_observedAt_idx" ON "TrOperationalUpdate"("featureId", "observedAt");

-- CreateIndex
CREATE INDEX "TrOperationalUpdate_recorderId_idx" ON "TrOperationalUpdate"("recorderId");

-- CreateIndex
CREATE INDEX "TrAnalysis_caseId_contextRevision_idx" ON "TrAnalysis"("caseId", "contextRevision");

-- CreateIndex
CREATE UNIQUE INDEX "TrPublicInformation_slug_key" ON "TrPublicInformation"("slug");

-- CreateIndex
CREATE INDEX "TrPublicInformation_status_type_publishedAt_idx" ON "TrPublicInformation"("status", "type", "publishedAt");

-- CreateIndex
CREATE INDEX "TrPublicInformation_caseId_idx" ON "TrPublicInformation"("caseId");

-- CreateIndex
CREATE INDEX "TrPublicInformation_authorId_idx" ON "TrPublicInformation"("authorId");

-- CreateIndex
CREATE INDEX "TrPublicInformation_publisherId_idx" ON "TrPublicInformation"("publisherId");

-- CreateIndex
CREATE INDEX "TrPublicInformation_supersedesId_idx" ON "TrPublicInformation"("supersedesId");

-- CreateIndex
CREATE INDEX "TrPublicInformationRegion_regionId_idx" ON "TrPublicInformationRegion"("regionId");

-- CreateIndex
CREATE INDEX "TrIntegrationRun_provider_startedAt_idx" ON "TrIntegrationRun"("provider", "startedAt");

-- CreateIndex
CREATE INDEX "TrAuditLog_targetType_targetId_createdAt_idx" ON "TrAuditLog"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "TrAuditLog_actorId_idx" ON "TrAuditLog"("actorId");

-- AddForeignKey
ALTER TABLE "TrSession" ADD CONSTRAINT "TrSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "MsUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAccount" ADD CONSTRAINT "TrAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "MsUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrReport" ADD CONSTRAINT "TrReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrReport" ADD CONSTRAINT "TrReport_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "MsRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrReport" ADD CONSTRAINT "TrReport_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TrCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrReportUpdate" ADD CONSTRAINT "TrReportUpdate_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TrReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrReportUpdate" ADD CONSTRAINT "TrReportUpdate_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrHotspot" ADD CONSTRAINT "TrHotspot_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TrCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrCase" ADD CONSTRAINT "TrCase_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "MsRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrCase" ADD CONSTRAINT "TrCase_latestAnalysisId_fkey" FOREIGN KEY ("latestAnalysisId") REFERENCES "TrAnalysis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrFieldUpdate" ADD CONSTRAINT "TrFieldUpdate_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TrCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrFieldUpdate" ADD CONSTRAINT "TrFieldUpdate_recorderId_fkey" FOREIGN KEY ("recorderId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrFieldUpdate" ADD CONSTRAINT "TrFieldUpdate_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "MsTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrVerification" ADD CONSTRAINT "TrVerification_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TrCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrVerification" ADD CONSTRAINT "TrVerification_decidingAdminId_fkey" FOREIGN KEY ("decidingAdminId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrVerification" ADD CONSTRAINT "TrVerification_fieldUpdateId_fkey" FOREIGN KEY ("fieldUpdateId") REFERENCES "TrFieldUpdate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrVerification" ADD CONSTRAINT "TrVerification_correctedDecisionId_fkey" FOREIGN KEY ("correctedDecisionId") REFERENCES "TrVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TrReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_reportUpdateId_fkey" FOREIGN KEY ("reportUpdateId") REFERENCES "TrReportUpdate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_fieldUpdateId_fkey" FOREIGN KEY ("fieldUpdateId") REFERENCES "TrFieldUpdate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "TrPublicInformation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_sourceAttachmentId_fkey" FOREIGN KEY ("sourceAttachmentId") REFERENCES "TrAttachment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MsRegion" ADD CONSTRAINT "MsRegion_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MsRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MsRegion" ADD CONSTRAINT "MsRegion_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "MsMapLayer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MsMapFeature" ADD CONSTRAINT "MsMapFeature_layerId_fkey" FOREIGN KEY ("layerId") REFERENCES "MsMapLayer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MsMapFeature" ADD CONSTRAINT "MsMapFeature_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "MsRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrWeatherForecast" ADD CONSTRAINT "TrWeatherForecast_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "MsRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MsEquipment" ADD CONSTRAINT "MsEquipment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "MsTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAssignment" ADD CONSTRAINT "TrAssignment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TrCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAssignment" ADD CONSTRAINT "TrAssignment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "MsTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAssignment" ADD CONSTRAINT "TrAssignment_assigningAdminId_fkey" FOREIGN KEY ("assigningAdminId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrOperationalUpdate" ADD CONSTRAINT "TrOperationalUpdate_recorderId_fkey" FOREIGN KEY ("recorderId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrOperationalUpdate" ADD CONSTRAINT "TrOperationalUpdate_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "MsTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrOperationalUpdate" ADD CONSTRAINT "TrOperationalUpdate_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "MsEquipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrOperationalUpdate" ADD CONSTRAINT "TrOperationalUpdate_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "MsMapFeature"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAnalysis" ADD CONSTRAINT "TrAnalysis_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TrCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrPublicInformation" ADD CONSTRAINT "TrPublicInformation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TrCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrPublicInformation" ADD CONSTRAINT "TrPublicInformation_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrPublicInformation" ADD CONSTRAINT "TrPublicInformation_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrPublicInformation" ADD CONSTRAINT "TrPublicInformation_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "TrPublicInformation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrPublicInformationRegion" ADD CONSTRAINT "TrPublicInformationRegion_publicInformationId_fkey" FOREIGN KEY ("publicInformationId") REFERENCES "TrPublicInformation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrPublicInformationRegion" ADD CONSTRAINT "TrPublicInformationRegion_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "MsRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrAuditLog" ADD CONSTRAINT "TrAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "MsUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MsUser" ADD CONSTRAINT "MsUser_privilege_check" CHECK ("role" = 'ADMIN' OR (NOT "canConfirmIncidents" AND NOT "canPublishInformation"));
CREATE UNIQUE INDEX "MsUser_email_normalized_key" ON "MsUser" (lower("email"));
ALTER TABLE "TrReport" ADD CONSTRAINT "TrReport_location_check" CHECK ((("latitude" IS NULL) = ("longitude" IS NULL)) AND ("latitude" IS NOT NULL OR "regionId" IS NOT NULL) AND ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180));
ALTER TABLE "TrReport" ADD CONSTRAINT "TrReport_observations_check" CHECK ("observationTypes" IS NOT NULL AND cardinality("observationTypes") BETWEEN 1 AND 3 AND ("accuracyMeters" IS NULL OR "accuracyMeters" BETWEEN 0 AND 100000));
ALTER TABLE "TrHotspot" ADD CONSTRAINT "TrHotspot_location_check" CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180 AND ("frp" IS NULL OR "frp" BETWEEN 0 AND 1000000000));
ALTER TABLE "TrCase" ADD CONSTRAINT "TrCase_location_check" CHECK ((("latitude" IS NULL) = ("longitude" IS NULL)) AND ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180));
ALTER TABLE "TrCase" ADD CONSTRAINT "TrCase_state_check" CHECK (("handlingStatus" != 'RESPONDING' OR "verificationStatus" = 'CONFIRMED_FIRE') AND "version" > 0 AND "contextRevision" > 0 AND (("handlingStatus" = 'CLOSED') = ("closedAt" IS NOT NULL)));
ALTER TABLE "TrFieldUpdate" ADD CONSTRAINT "TrFieldUpdate_location_check" CHECK ((("latitude" IS NULL) = ("longitude" IS NULL)) AND ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90) AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180));
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_parent_check" CHECK (("state" = 'ATTACHED' AND num_nonnulls("reportId", "reportUpdateId", "fieldUpdateId", "publicationId") = 1) OR ("state" != 'ATTACHED' AND num_nonnulls("reportId", "reportUpdateId", "fieldUpdateId", "publicationId") = 0));
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_content_check" CHECK ("size" BETWEEN 1 AND 5242880 AND "contentType" IN ('image/jpeg', 'image/png', 'image/webp') AND ("state" NOT IN ('READY', 'ATTACHED') OR ("detectedType" = "contentType" AND "digest" IS NOT NULL)));
ALTER TABLE "TrAttachment" ADD CONSTRAINT "TrAttachment_public_approval_check" CHECK ("publicationId" IS NULL OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "publicationUseBasis" IS NOT NULL AND "redactionReview" IS NOT NULL));
ALTER TABLE "TrOperationalUpdate" ADD CONSTRAINT "TrOperationalUpdate_subject_check" CHECK (num_nonnulls("teamId", "equipmentId", "featureId") = 1 AND (("subjectType" = 'TEAM' AND "teamId" IS NOT NULL) OR ("subjectType" = 'EQUIPMENT' AND "equipmentId" IS NOT NULL) OR ("subjectType" = 'FEATURE' AND "featureId" IS NOT NULL)));
ALTER TABLE "TrOperationalUpdate" ADD CONSTRAINT "TrOperationalUpdate_condition_check" CHECK (("subjectType" = 'TEAM' AND "condition" IN ('AVAILABLE','DEPLOYED','UNAVAILABLE','UNKNOWN')) OR ("subjectType" = 'EQUIPMENT' AND "condition" IN ('AVAILABLE','IN_USE','DAMAGED','UNAVAILABLE','UNKNOWN')) OR ("subjectType" = 'FEATURE' AND "condition" IN ('PASSABLE','RESTRICTED','IMPASSABLE','WATER_AVAILABLE','WATER_UNAVAILABLE','UNKNOWN')));
ALTER TABLE "TrWeatherForecast" ADD CONSTRAINT "TrWeatherForecast_values_check" CHECK (("windFromDegrees" IS NULL OR ("windFromDegrees" >= 0 AND "windFromDegrees" < 360)) AND ("windSpeed" IS NULL OR "windSpeed" BETWEEN 0 AND 1000) AND ("humidity" IS NULL OR "humidity" BETWEEN 0 AND 100) AND "issuedAt" <= "validAt");
ALTER TABLE "TrPublicInformation" ADD CONSTRAINT "TrPublicInformation_location_check" CHECK (("publicLocationMode" = 'APPROVED_INCIDENT_POINT' AND "caseId" IS NOT NULL AND "privacyReview" IS NOT NULL AND "publicLatitude" IS NOT NULL AND "publicLongitude" IS NOT NULL AND "publicLatitude" BETWEEN -90 AND 90 AND "publicLongitude" BETWEEN -180 AND 180) OR ("publicLocationMode" != 'APPROVED_INCIDENT_POINT' AND "publicLatitude" IS NULL AND "publicLongitude" IS NULL));
ALTER TABLE "TrPublicInformation" ADD CONSTRAINT "TrPublicInformation_validity_check" CHECK (("publishedAt" IS NULL OR "validUntil" IS NULL OR "publishedAt" < "validUntil") AND ("status" = 'DRAFT' OR ("publisherId" IS NOT NULL AND "publishedAt" IS NOT NULL AND "authorityReference" IS NOT NULL)));
CREATE UNIQUE INDEX "TrAssignment_active_team_key" ON "TrAssignment" ("teamId") WHERE "status" IN ('ASSIGNED','ACCEPTED','IN_PROGRESS');
CREATE UNIQUE INDEX "TrAnalysis_running_context_key" ON "TrAnalysis" ("caseId", "contextRevision") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "TrIntegrationRun_running_provider_key" ON "TrIntegrationRun" ("provider") WHERE "status" = 'RUNNING';
ALTER TABLE "MsRegion" ADD CONSTRAINT "MsRegion_level_check" CHECK ("level" BETWEEN 1 AND 4 AND ("bmkgAdm4" IS NULL OR ("level" = 4 AND "bmkgAdm4" ~ '^\d{2}\.\d{2}\.\d{2}\.\d{4}$')));
ALTER TABLE "MsSiteProfile" ADD CONSTRAINT "MsSiteProfile_singleton_check" CHECK ("id" = 'site');
