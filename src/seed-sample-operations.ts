import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { db, disconnect } from './config/db.js';
import { jsonValue } from './utils/index.js';

export const sampleOperationsProvenance = 'sample-operations-v1';
export const sampleOperationsNotice = 'Sample operational data; synthetic and not evidence of real availability, access, or water supply.';
const sourceDate = new Date('2026-09-19T00:00:00.000Z');

export function sampleOperationsPlan(_now = new Date()) {
  const teams = [
    { id: `${sampleOperationsProvenance}-team-01`, name: 'Tim Reaksi Cepat Palangka Raya', organization: 'Sample operations' },
    { id: `${sampleOperationsProvenance}-team-02`, name: 'Tim Dukungan Air Palangka Raya', organization: 'Sample operations' },
    { id: `${sampleOperationsProvenance}-team-03`, name: 'Tim Akses Lapangan Palangka Raya', organization: 'Sample operations' },
  ];
  const equipment = [
    { id: `${sampleOperationsProvenance}-equipment-01`, name: 'Pompa Portabel', kind: 'Pompa', teamId: teams[1]!.id },
    { id: `${sampleOperationsProvenance}-equipment-02`, name: 'Tangki Air', kind: 'Tangki', teamId: teams[1]!.id },
    { id: `${sampleOperationsProvenance}-equipment-03`, name: 'Selang Pemadam', kind: 'Selang', teamId: teams[0]!.id },
    { id: `${sampleOperationsProvenance}-equipment-04`, name: 'Perahu Operasional', kind: 'Perahu', teamId: teams[2]!.id },
    { id: `${sampleOperationsProvenance}-equipment-05`, name: 'Radio Lapangan', kind: 'Komunikasi', teamId: teams[0]!.id },
    { id: `${sampleOperationsProvenance}-equipment-06`, name: 'Unit Penerangan', kind: 'Penerangan', teamId: teams[2]!.id },
  ];
  const attributes = { provenance: sampleOperationsProvenance, synthetic: true, authoritative: false, routingEligible: false, notice: sampleOperationsNotice };
  const layers = [
    {
      id: `${sampleOperationsProvenance}-layer-road`,
      name: 'Sample access routes',
      kind: 'ROAD' as const,
      provider: 'SAMPLE',
      sourceUrl: 'urn:blazemap:sample-operations-v1:roads',
      license: 'Synthetic',
      attribution: 'Blazemap synthetic sample; not an official road source',
      coverage: 'Synthetic training coordinates near Palangka Raya; not surveyed access routes',
      version: '1',
      sourceDate,
      verifiedAt: null,
      features: [
        { id: `${sampleOperationsProvenance}-road-01`, sourceId: 'access-01', name: 'Akses Latihan Utara', geometry: { type: 'LineString', coordinates: [[113.911, -2.194], [113.925, -2.187], [113.939, -2.181]] }, attributes },
        { id: `${sampleOperationsProvenance}-road-02`, sourceId: 'access-02', name: 'Akses Latihan Timur', geometry: { type: 'LineString', coordinates: [[113.935, -2.218], [113.949, -2.211], [113.961, -2.202]] }, attributes },
        { id: `${sampleOperationsProvenance}-road-03`, sourceId: 'access-03', name: 'Akses Latihan Selatan', geometry: { type: 'LineString', coordinates: [[113.902, -2.236], [113.916, -2.23], [113.931, -2.225]] }, attributes },
      ],
    },
    {
      id: `${sampleOperationsProvenance}-layer-water`,
      name: 'Sample water sources',
      kind: 'WATER_SOURCE' as const,
      provider: 'SAMPLE',
      sourceUrl: 'urn:blazemap:sample-operations-v1:water',
      license: 'Synthetic',
      attribution: 'Blazemap synthetic sample; not an official water source',
      coverage: 'Synthetic training coordinates near Palangka Raya; not surveyed water sources',
      version: '1',
      sourceDate,
      verifiedAt: null,
      features: [
        { id: `${sampleOperationsProvenance}-water-01`, sourceId: 'water-01', name: 'Sumber Air Latihan A', geometry: { type: 'Point', coordinates: [113.918, -2.205] }, attributes },
        { id: `${sampleOperationsProvenance}-water-02`, sourceId: 'water-02', name: 'Sumber Air Latihan B', geometry: { type: 'Point', coordinates: [113.947, -2.224] }, attributes },
        { id: `${sampleOperationsProvenance}-water-03`, sourceId: 'water-03', name: 'Sumber Air Latihan C', geometry: { type: 'Point', coordinates: [113.889, -2.216] }, attributes },
      ],
    },
  ];
  const subjects = [
    ...teams.map((item, index) => ({ id: `${sampleOperationsProvenance}-update-team-${String(index + 1).padStart(2, '0')}`, subjectType: 'TEAM' as const, subjectId: item.id, condition: 'UNKNOWN' })),
    ...equipment.map((item, index) => ({ id: `${sampleOperationsProvenance}-update-equipment-${String(index + 1).padStart(2, '0')}`, subjectType: 'EQUIPMENT' as const, subjectId: item.id, condition: 'UNKNOWN' })),
    ...layers.flatMap(layer => layer.features.map((item, index) => ({ id: `${sampleOperationsProvenance}-update-${layer.kind.toLowerCase()}-${String(index + 1).padStart(2, '0')}`, subjectType: 'FEATURE' as const, subjectId: item.id, condition: 'UNKNOWN' }))),
  ];
  return { teams, equipment, layers, updates: subjects.map(item => ({ ...item, source: 'Sample operational data', observedAt: sourceDate, notes: sampleOperationsNotice })) };
}

export function sampleOperationsFlags(args: string[]) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean' }, 'confirm-sample-operations': { type: 'boolean' }, 'with-assignments': { type: 'boolean' } }, allowPositionals: false });
  if (!!values.apply !== !!values['confirm-sample-operations']) throw new Error('Both write flags required');
  return !!values.apply;
}

const auditDetails = (targetType: string, key: string) => ({ provenance: sampleOperationsProvenance, synthetic: true, authoritative: false, targetType, key, notice: sampleOperationsNotice });

export function sampleAssignmentPlan() {
  return (['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'] as const).map((status, index) => ({
    id: `${sampleOperationsProvenance}-assignment-${index + 1}`,
    caseId: status === 'COMPLETED' ? 'sample-v2-case-01' : 'sample-v2-case-02',
    teamId: `${sampleOperationsProvenance}-team-0${index + 1}`,
    status,
    notes: 'Training scenario — simulated assignment, not a dispatch or evidence of team readiness. Record timestamps indicate fixture creation only.',
    version: 1,
    idempotencyKey: `${sampleOperationsProvenance}-assignment-${index + 1}`,
    payloadHash: null,
  }));
}

export async function inspectSampleAssignmentTargets(tx: Prisma.TransactionClient) {
  for (const [caseId, reportId, key, handlingStatus] of [
    ['sample-v2-case-01', 'sample-v2-report-record-08', 'sample-v2-report-08', 'CLOSED'],
    ['sample-v2-case-02', 'sample-v2-report-record-10', 'sample-v2-report-10', 'MONITORING'],
  ] as const) {
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${caseId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${reportId} FOR SHARE`;
    const incident = await tx.trCase.findUnique({ where: { id: caseId }, include: { reports: true, _count: { select: { hotspots: true, analyses: true } } } });
    if (!incident || incident.handlingStatus !== handlingStatus || incident.perimeterSource !== 'Training fixture' || incident.latestAnalysisId || incident._count.hotspots || incident._count.analyses || incident.reports.length !== 1) throw new Error('Synthetic case missing or mixed with operational signals');
    const report = incident.reports[0]!;
    const audits = await tx.trAuditLog.findMany({ where: { systemActor: 'sample-report-v2', OR: [{ action: 'SAMPLE_CASE_AND_PUBLICATION_CREATED', targetType: 'CASE', targetId: caseId }, { action: 'SAMPLE_REPORT_CREATED', targetType: 'REPORT', targetId: reportId }] }, select: { targetType: true, details: true } });
    const caseAudits = audits.filter(item => item.targetType === 'CASE');
    const reportAudits = audits.filter(item => item.targetType === 'REPORT');
    const caseProof = caseAudits[0]?.details as Record<string, unknown> | undefined;
    const reportProof = reportAudits[0]?.details as Record<string, unknown> | undefined;
    if (caseAudits.length !== 1 || reportAudits.length !== 1 || caseProof?.isSynthetic !== true || caseProof.version !== 2 || caseProof.authorityReference !== 'Training fixture' || caseProof.reportId !== reportId || reportProof?.isSynthetic !== true || reportProof.version !== 2 || reportProof.governmentConfirmation !== false || reportProof.idempotencyKey !== key || reportProof.payloadHash !== report.payloadHash || report.id !== reportId || report.idempotencyKey !== key) throw new Error('Synthetic case/report provenance mismatch');
  }
}

export async function seedSampleOperations(client: PrismaClient, apply = false, withAssignments = false) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sample-operations-v1-seeder'))`;
    const actor = await tx.msUser.findFirst({ where: { role: 'ADMIN', active: true, emailVerified: true }, select: { id: true }, orderBy: { id: 'asc' } });
    if (!actor) throw new Error('An active verified administrator is required as the sample update recorder');
    const preservation = async () => {
      const [result] = await tx.$queryRaw<{ users: bigint; reports: bigint; hotspots: bigint; firmsRuns: bigint; userHash: string; reportHash: string; hotspotHash: string; firmsRunHash: string }[]>`
        SELECT
          (SELECT count(*) FROM "MsUser") AS users,
          (SELECT count(*) FROM "TrReport") AS reports,
          (SELECT count(*) FROM "TrHotspot") AS hotspots,
          (SELECT count(*) FROM "TrIntegrationRun" WHERE provider = 'FIRMS') AS "firmsRuns",
          (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY record.id), '')) FROM "MsUser" record) AS "userHash",
          (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY record.id), '')) FROM "TrReport" record) AS "reportHash",
          (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY record.id), '')) FROM "TrHotspot" record) AS "hotspotHash",
          (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY record.id), '')) FROM "TrIntegrationRun" record WHERE record.provider = 'FIRMS') AS "firmsRunHash"
      `;
      if (!result) throw new Error('Protected record verification unavailable');
      const counts = { users: Number(result.users), reports: Number(result.reports), hotspots: Number(result.hotspots), firmsRuns: Number(result.firmsRuns) };
      if (Object.values(counts).some(count => !Number.isSafeInteger(count) || count > 1000000)) throw new Error('Preservation verification bound exceeded');
      return { counts, hashes: { users: result.userHash, reports: result.reportHash, hotspots: result.hotspotHash, firmsRuns: result.firmsRunHash } };
    };
    const before = await preservation();
    const plan = sampleOperationsPlan();
    if (withAssignments) await inspectSampleAssignmentTargets(tx);
    const assignments = withAssignments ? sampleAssignmentPlan() : [];
    const caseSnapshot = await tx.trCase.findMany({ orderBy: { id: 'asc' } });
    const assignmentSnapshot = await tx.trAssignment.findMany({ where: { id: { notIn: assignments.map(item => item.id) } }, orderBy: { id: 'asc' } });
    const created = { teams: 0, equipment: 0, layers: 0, features: 0, updates: 0, assignments: 0, audits: 0 };
    const existing = { teams: 0, equipment: 0, layers: 0, features: 0, updates: 0, assignments: 0 };
    const requireAudit = async (targetType: string, targetId: string, key: string) => {
      const rows = await tx.trAuditLog.findMany({ where: { systemActor: sampleOperationsProvenance, action: 'SAMPLE_OPERATION_CREATED', targetType, targetId }, select: { details: true }, take: 2 });
      if (rows.length !== 1 || !isDeepStrictEqual(rows[0]!.details, auditDetails(targetType, key))) throw new Error(`Sample provenance mismatch for ${targetType}`);
    };
    const addAudit = async (targetType: string, targetId: string, key: string) => {
      await tx.trAuditLog.create({ data: { systemActor: sampleOperationsProvenance, action: 'SAMPLE_OPERATION_CREATED', targetType, targetId, reason: sampleOperationsNotice, details: auditDetails(targetType, key) } });
      created.audits++;
    };
    for (const item of plan.teams) {
      const collisions = await tx.msTeam.findMany({ where: { OR: [{ id: item.id }, { name: item.name }] }, select: { id: true, name: true, organization: true, active: true, version: true, idempotencyKey: true, payloadHash: true } });
      if (collisions.length) {
        if (collisions.length !== 1 || !isDeepStrictEqual(collisions[0], { ...item, active: true, version: 1, idempotencyKey: null, payloadHash: null })) throw new Error(`Team collision: ${item.name}`);
        await requireAudit('TEAM', item.id, item.id);
        existing.teams++;
      } else if (apply) {
        await tx.msTeam.create({ data: item });
        await addAudit('TEAM', item.id, item.id);
        created.teams++;
      }
    }
    for (const item of plan.equipment) {
      const collisions = await tx.msEquipment.findMany({ where: { OR: [{ id: item.id }, { name: item.name }] }, select: { id: true, name: true, kind: true, teamId: true, active: true, version: true, idempotencyKey: true, payloadHash: true } });
      if (collisions.length) {
        if (collisions.length !== 1 || !isDeepStrictEqual(collisions[0], { ...item, active: true, version: 1, idempotencyKey: null, payloadHash: null })) throw new Error(`Equipment collision: ${item.name}`);
        await requireAudit('EQUIPMENT', item.id, item.id);
        existing.equipment++;
      } else if (apply) {
        await tx.msEquipment.create({ data: item });
        await addAudit('EQUIPMENT', item.id, item.id);
        created.equipment++;
      }
    }
    for (const layer of plan.layers) {
      const { features, ...item } = layer;
      const collisions = await tx.msMapLayer.findMany({ where: { OR: [{ id: item.id }, { provider: item.provider, name: item.name, version: item.version }] }, select: { id: true, name: true, kind: true, provider: true, sourceUrl: true, license: true, attribution: true, coverage: true, version: true, sourceDate: true, verifiedAt: true } });
      if (collisions.length) {
        if (collisions.length !== 1 || !isDeepStrictEqual(collisions[0], item)) throw new Error(`Layer collision: ${item.name}`);
        await requireAudit('MAP_LAYER', item.id, item.id);
        existing.layers++;
      } else if (apply) {
        await tx.msMapLayer.create({ data: item });
        await addAudit('MAP_LAYER', item.id, item.id);
        created.layers++;
      }
      for (const feature of features) {
        const collisions = await tx.msMapFeature.findMany({ where: { OR: [{ id: feature.id }, { layerId: item.id, sourceId: feature.sourceId }] }, select: { id: true, layerId: true, sourceId: true, kind: true, name: true, geometry: true, attributes: true, regionId: true } });
        const expected = { ...feature, layerId: item.id, kind: item.kind, regionId: null };
        if (collisions.length) {
          if (collisions.length !== 1 || !isDeepStrictEqual(collisions[0], expected)) throw new Error(`Feature collision: ${feature.name}`);
          await requireAudit('FEATURE', feature.id, feature.id);
          existing.features++;
        } else if (apply) {
          await tx.msMapFeature.create({ data: { ...expected, geometry: jsonValue(feature.geometry), attributes: jsonValue(feature.attributes) } });
          await addAudit('FEATURE', feature.id, feature.id);
          created.features++;
        }
      }
    }
    for (const item of plan.updates) {
      const prior = await tx.trOperationalUpdate.findUnique({ where: { id: item.id }, select: { id: true, subjectType: true, teamId: true, equipmentId: true, featureId: true, condition: true, source: true, observedAt: true, notes: true, idempotencyKey: true, payloadHash: true } });
      const expected = { id: item.id, subjectType: item.subjectType, teamId: item.subjectType === 'TEAM' ? item.subjectId : null, equipmentId: item.subjectType === 'EQUIPMENT' ? item.subjectId : null, featureId: item.subjectType === 'FEATURE' ? item.subjectId : null, condition: item.condition, source: item.source, observedAt: item.observedAt, notes: item.notes, idempotencyKey: null, payloadHash: null };
      if (prior) {
        if (!isDeepStrictEqual(prior, expected)) throw new Error(`Operational update collision: ${item.id}`);
        await requireAudit('OPERATIONAL_UPDATE', item.id, item.id);
        existing.updates++;
      } else if (apply) {
        await tx.trOperationalUpdate.create({ data: { ...expected, recorderId: actor.id } });
        await addAudit('OPERATIONAL_UPDATE', item.id, item.id);
        created.updates++;
      }
    }
    for (const item of assignments) {
      await tx.$queryRaw`SELECT id FROM "MsTeam" WHERE id = ${item.teamId} FOR UPDATE`;
      await requireAudit('TEAM', item.teamId, item.teamId);
      const unrelated = await tx.trAssignment.count({ where: { teamId: item.teamId, id: { notIn: assignments.map(row => row.id) } } });
      if (unrelated) throw new Error('Sample team has unrelated assignments');
      const details = { ...auditDetails('ASSIGNMENT', item.id), scenario: 'SIMULATED', caseId: item.caseId, status: item.status, dispatch: false, timestampBasis: 'FIXTURE_RECORD_CREATION', scenarioAt: sourceDate.toISOString() };
      const prior = await tx.trAssignment.findMany({ where: { OR: [{ id: item.id }, { idempotencyKey: item.idempotencyKey }] } });
      if (prior.length) {
        const { createdAt: _created, updatedAt: _updated, assigningAdminId: _admin, ...stored } = prior[0]!;
        const audits = await tx.trAuditLog.findMany({ where: { systemActor: sampleOperationsProvenance, action: 'SAMPLE_OPERATION_CREATED', targetType: 'ASSIGNMENT', targetId: item.id }, select: { details: true } });
        if (prior.length !== 1 || !isDeepStrictEqual(stored, item) || audits.length !== 1 || !isDeepStrictEqual(audits[0]!.details, details)) throw new Error('Sample assignment collision or provenance mismatch');
        existing.assignments++;
      } else if (apply) {
        await tx.trAssignment.create({ data: { ...item, assigningAdminId: actor.id } });
        await tx.trAuditLog.create({ data: { systemActor: sampleOperationsProvenance, action: 'SAMPLE_OPERATION_CREATED', targetType: 'ASSIGNMENT', targetId: item.id, reason: item.notes, details } });
        created.assignments++;
        created.audits++;
      }
    }
    if (!isDeepStrictEqual(caseSnapshot, await tx.trCase.findMany({ orderBy: { id: 'asc' } })) || !isDeepStrictEqual(assignmentSnapshot, await tx.trAssignment.findMany({ where: { id: { notIn: assignments.map(item => item.id) } }, orderBy: { id: 'asc' } }))) throw new Error('Protected cases or assignments changed');
    const after = await preservation();
    if (!isDeepStrictEqual(before, after)) throw new Error('Protected FIRMS, report, or user records changed');
    const expectedCounts = { teams: plan.teams.length, equipment: plan.equipment.length, layers: plan.layers.length, features: plan.layers.reduce((sum, layer) => sum + layer.features.length, 0), updates: plan.updates.length, assignments: assignments.length };
    if (apply) {
      const actual = {
        assignments: await tx.trAssignment.count({ where: { id: { in: assignments.map(item => item.id) } } }),
        teams: await tx.msTeam.count({ where: { id: { in: plan.teams.map(item => item.id) } } }),
        equipment: await tx.msEquipment.count({ where: { id: { in: plan.equipment.map(item => item.id) } } }),
        layers: await tx.msMapLayer.count({ where: { id: { in: plan.layers.map(item => item.id) } } }),
        features: await tx.msMapFeature.count({ where: { id: { in: plan.layers.flatMap(layer => layer.features.map(item => item.id)) } } }),
        updates: await tx.trOperationalUpdate.count({ where: { id: { in: plan.updates.map(item => item.id) } } }),
      };
      if (!isDeepStrictEqual(actual, expectedCounts)) throw new Error('Sample operation count verification failed');
    }
    return { mode: apply ? 'APPLIED' : 'DRY_RUN', provenance: sampleOperationsProvenance, created, existing, planned: expectedCounts, protectedBefore: before.counts, protectedAfter: after.counts, protectedHashesUnchanged: true, authoritative: false };
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 60000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await seedSampleOperations(db(), sampleOperationsFlags(process.argv.slice(2)), process.argv.includes('--with-assignments')))); }
  catch { console.error('Sample operations seed refused or failed; check flags, collisions, provenance, migrations, and database availability. Existing records were not changed.'); process.exitCode = 1; }
  finally { await disconnect(); }
}
