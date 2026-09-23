import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { databaseConnectionConfig } from './config/db.js';
import { PrismaClient } from './generated/prisma/client.js';
import { jsonValue } from './utils/index.js';
import type { Transaction } from './types/index.js';

const fixtureKey = 'initial-operations-v1';
const systemActor = 'operations-initializer-v1';
const reason = 'Initial operational coordination data recorded for application use.';
export const operationsFixtureIds = {
  teams: ['fdb751f6-8a22-4f0e-87d1-5b9b219aad4c', '43b61307-906a-4132-837e-798a8346b0a3', '75eeb569-4dcd-4066-84db-511cddf5b857'],
  equipment: ['c67f44aa-b1ab-470c-9c2d-d4dcc7a195a0', '23497bcb-2b9c-453f-aa3d-9bbdb48d9e8b', '15f7138d-9a56-4e6e-be2a-28715e4fa0d6', '5bc9ed97-a6a6-4f3d-b82d-0f508c81023f', '717cb627-b93a-4b6c-b109-f584814f35b1', '7c0f91bc-ec55-4bdb-8322-11a267565ce8'],
  cases: ['60eb3058-4a48-4a52-8d97-09b86b0918c6', '007bf3df-0402-47d0-aa73-e09467855f89', 'f0778b46-588e-4dda-9cff-a3e41e178643'],
  assignments: ['d76ae09f-b231-43d4-84f6-1b2d493fee1a', 'd2388edc-285e-4952-b896-ae0a3617957e', 'e69f1d49-a75a-403a-ae90-19e4ce3a1690'],
  fieldUpdates: ['cb8914c2-ff01-4c32-a793-69479015bbe9', '6cb57d20-2728-49bc-8165-45d0e36808c3'],
  layer: '387f2f91-78df-4435-b0a5-c3fc9478ef36',
  features: ['4eaf9083-56c3-45c8-af7a-aafb6b6cabac', 'f013fd6a-390e-4567-8f1b-c6af98a81068', '894a076a-d65a-4664-8f26-066f968ec9a7', '8991bfb8-78b3-423a-a184-678febf547bb'],
  teamUpdates: ['509720bf-af0b-4861-9ca6-8a446d8cfc80', '239832fc-caa8-4957-80d2-7dd63ae872fb', '6ce5e6e0-c7bb-49c1-8eb1-d6f778ba2ab2'],
  equipmentUpdates: ['24ec8d24-aa81-4682-a86e-6aca9b8490f7', '266e7d3a-24ec-47af-9317-0c708977753a', '40c4f802-bbee-4d08-9211-ee9ea0cf8500', '0cf966af-a451-4c4e-a4e1-23704b7f49ec', '30a843bf-b255-48ad-bc57-21395c9d335d', 'cbf1e8e7-a9fb-4d52-aa4b-9700a96933e6'],
  featureUpdates: ['2adc86f4-65bb-47db-96aa-009de34578dd', '8ef3fbb8-fddb-4669-89d4-efbb1e4b7267', '1f22297f-5ac4-4732-b561-c03ad042388e', '188c9f5d-028f-417b-b758-cbf505f10be0'],
  verification: '791a2837-78a5-430e-a11e-e4d0e34580ff',
  batchAudit: '612bc5e6-7301-425c-b6fc-8032d71359a9',
} as const;
class OperationsSeedError extends Error {}
function requireSeed(condition: unknown, message: string): asserts condition { if (!condition) throw new OperationsSeedError(message); }
const legacyId = (kind: string, value: number) => `operations-seed-v1-${kind}-${String(value).padStart(2, '0')}`;
const legacyFixtureIds = {
  teams: [1, 2, 3].map(value => legacyId('team', value)),
  equipment: [1, 2, 3, 4, 5, 6].map(value => legacyId('equipment', value)),
  cases: [1, 2, 3].map(value => legacyId('case', value)),
  assignments: [1, 2, 3].map(value => legacyId('assignment', value)),
  fieldUpdates: [1, 2].map(value => legacyId('field', value)),
  layer: legacyId('layer', 1),
  features: [1, 2, 3, 4].map(value => legacyId('feature', value)),
  teamUpdates: [1, 2, 3].map(value => legacyId('update-team', value)),
  equipmentUpdates: [1, 2, 3, 4, 5, 6].map(value => legacyId('update-equipment', value)),
  featureUpdates: [1, 2, 3, 4].map(value => legacyId('update-feature', value)),
  verification: legacyId('verification', 1),
  batchAudit: legacyId('audit-batch', 1),
};
const atForSeed = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

export function guardOperationsSeed(env: NodeJS.ProcessEnv) {
  requireSeed(['development', 'test'].includes(env.NODE_ENV ?? ''), 'Operations seed is restricted to development or test.');
  requireSeed(!!env.DATABASE_URL, 'DATABASE_URL is required.');
  return { databaseUrl: env.DATABASE_URL, ca: env.DATABASE_CA_PEM };
}

export function operationsSeedPlan(now = new Date()) {
  const at = (minutes: number) => atForSeed(now, minutes);
  const teams = [
    { id: operationsFixtureIds.teams[0], name: 'Tim Reaksi Cepat Kapuas', organization: 'BPBD Kabupaten Kapuas' },
    { id: operationsFixtureIds.teams[1], name: 'Satuan Tugas Sebangau', organization: 'BPBD Kota Palangka Raya' },
    { id: operationsFixtureIds.teams[2], name: 'Tim Pengendalian Katingan', organization: 'BPBD Kabupaten Katingan' },
  ];
  const equipment = [
    { id: operationsFixtureIds.equipment[0], name: 'Pompa Portabel P-01', kind: 'Portable pump', teamId: teams[1]!.id },
    { id: operationsFixtureIds.equipment[1], name: 'Tangki Air 4.000 Liter', kind: 'Water tanker', teamId: teams[1]!.id },
    { id: operationsFixtureIds.equipment[2], name: 'Radio Lapangan VHF-01', kind: 'VHF radio', teamId: teams[0]!.id },
    { id: operationsFixtureIds.equipment[3], name: 'Kendaraan Operasional 4x4', kind: 'Field vehicle', teamId: teams[2]!.id },
    { id: operationsFixtureIds.equipment[4], name: 'Selang Pemadam 200 Meter', kind: 'Fire hose', teamId: teams[1]!.id },
    { id: operationsFixtureIds.equipment[5], name: 'GPS Lapangan G-01', kind: 'Navigation device', teamId: teams[0]!.id },
  ];
  const cases = [
    { id: operationsFixtureIds.cases[0], number: 'BM-KAP-2026-001', title: 'Pemeriksaan kanal Mantangai', latitude: -2.5128, longitude: 114.4371, verificationStatus: 'UNVERIFIED' as const, handlingStatus: 'CHECK_SCHEDULED' as const, priority: 'HIGH' as const, priorityReason: 'Vegetasi kering dan laporan asap memerlukan pemeriksaan lapangan.', openedAt: at(180), closedAt: null, closureReason: null },
    { id: operationsFixtureIds.cases[1], number: 'BM-PLK-2026-002', title: 'Penanganan lapangan Sebangau', latitude: -2.2974, longitude: 113.8912, verificationStatus: 'UNVERIFIED' as const, handlingStatus: 'ON_SCENE' as const, priority: 'HIGH' as const, priorityReason: 'Tim lapangan sedang memeriksa indikasi api dan batas area terdampak.', openedAt: at(150), closedAt: null, closureReason: null },
    { id: operationsFixtureIds.cases[2], number: 'BM-KTG-2026-003', title: 'Pemeriksaan akses Katingan', latitude: -1.9788, longitude: 113.3825, verificationStatus: 'NOT_FIRE' as const, handlingStatus: 'CLOSED' as const, priority: 'LOW' as const, priorityReason: 'Pemeriksaan lapangan selesai tanpa menemukan indikasi kebakaran.', openedAt: at(1440), closedAt: at(1220), closureReason: 'Pemeriksaan lapangan tidak menemukan indikasi kebakaran.' },
  ];
  const assignments = [
    { id: operationsFixtureIds.assignments[0], caseId: cases[0]!.id, teamId: teams[0]!.id, status: 'ASSIGNED' as const, notes: 'Verifikasi sumber asap dan koordinat laporan.', createdAt: at(120) },
    { id: operationsFixtureIds.assignments[1], caseId: cases[1]!.id, teamId: teams[1]!.id, status: 'IN_PROGRESS' as const, notes: 'Periksa kondisi lapangan dan catat batas area terdampak.', createdAt: at(110), acceptedAt: at(105), startedAt: at(95) },
    { id: operationsFixtureIds.assignments[2], caseId: cases[2]!.id, teamId: teams[2]!.id, status: 'COMPLETED' as const, notes: 'Periksa akses dan validasi indikasi yang dilaporkan.', createdAt: at(1380), acceptedAt: at(1360), startedAt: at(1320), completedAt: at(1260) },
  ];
  const fieldUpdates = [
    { id: operationsFixtureIds.fieldUpdates[0], caseId: cases[1]!.id, assignmentId: assignments[1]!.id, teamId: teams[1]!.id, findings: 'VISIBLE_FIRE' as const, description: 'Api terlihat pada vegetasi kering di sisi timur kanal.', source: 'Laporan Satuan Tugas Sebangau', observedAt: at(60), latitude: -2.2971, longitude: 113.8916 },
    { id: operationsFixtureIds.fieldUpdates[1], caseId: cases[2]!.id, assignmentId: assignments[2]!.id, teamId: teams[2]!.id, findings: 'NO_INDICATION' as const, description: 'Pemeriksaan lokasi selesai tanpa menemukan asap, bara, atau api.', source: 'Laporan Tim Pengendalian Katingan', observedAt: at(1270), latitude: -1.9789, longitude: 113.3827 },
  ];
  const layer = { id: operationsFixtureIds.layer, name: 'Titik Operasional Kalimantan Tengah', kind: 'DESIGNATED_LOCATION' as const, provider: 'BPBD Kalimantan Tengah', sourceUrl: 'urn:blazemap:operations:initial-v1', license: 'Data operasional internal', attribution: 'BPBD Kalimantan Tengah', coverage: 'Titik akses dan sumber air operasional di Kalimantan Tengah', version: '1', sourceDate: at(1440), verifiedAt: now };
  const features = [
    { id: operationsFixtureIds.features[0], sourceId: 'access-mantangai', kind: 'ROAD' as const, name: 'Titik Akses Kanal Mantangai', longitude: 114.4318, latitude: -2.5086, condition: 'RESTRICTED' },
    { id: operationsFixtureIds.features[1], sourceId: 'access-sebangau', kind: 'ROAD' as const, name: 'Titik Akses Sebangau', longitude: 113.8844, latitude: -2.3012, condition: 'PASSABLE' },
    { id: operationsFixtureIds.features[2], sourceId: 'water-sebangau', kind: 'WATER_SOURCE' as const, name: 'Sumber Air Sebangau', longitude: 113.8975, latitude: -2.3041, condition: 'WATER_AVAILABLE' },
    { id: operationsFixtureIds.features[3], sourceId: 'water-katingan', kind: 'WATER_SOURCE' as const, name: 'Sumber Air Katingan', longitude: 113.3768, latitude: -1.9822, condition: 'WATER_UNAVAILABLE' },
  ];
  const updates = [
    ...teams.map((team, index) => ({ id: operationsFixtureIds.teamUpdates[index]!, subjectType: 'TEAM' as const, teamId: team.id, condition: index === 2 ? 'AVAILABLE' : 'DEPLOYED', observedAt: at(index === 2 ? 20 : 45), source: 'Laporan kesiapan Posko Komando' })),
    ...equipment.map((item, index) => ({ id: operationsFixtureIds.equipmentUpdates[index]!, subjectType: 'EQUIPMENT' as const, equipmentId: item.id, condition: item.teamId === teams[1]!.id ? 'IN_USE' : 'AVAILABLE', observedAt: at(30 + index), source: 'Pemeriksaan logistik lapangan' })),
    ...features.map((feature, index) => ({ id: operationsFixtureIds.featureUpdates[index]!, subjectType: 'FEATURE' as const, featureId: feature.id, condition: feature.condition, observedAt: at(40 + index), source: 'Pemeriksaan akses dan sumber daya lapangan' })),
  ];
  const verification = { id: operationsFixtureIds.verification, caseId: cases[2]!.id, fieldUpdateId: fieldUpdates[1]!.id, authorityReference: 'BPBD-KTG/OPS/2026-003', outcome: 'NOT_FIRE' as const, previousStatus: 'UNVERIFIED' as const, newStatus: 'NOT_FIRE' as const, reason: 'Pemeriksaan lapangan tidak menemukan indikasi kebakaran.', createdAt: at(1230) };
  return { teams, equipment, cases, assignments, fieldUpdates, layer, features, updates, verification };
}

async function fixtureCounts(tx: Transaction, ids: { teams: readonly string[]; equipment: readonly string[]; cases: readonly string[]; assignments: readonly string[]; fieldUpdates: readonly string[]; layer: string; features: readonly string[]; updates: readonly string[]; verification: string }) {
  return Promise.all([
    tx.msTeam.count({ where: { id: { in: [...ids.teams] } } }),
    tx.msEquipment.count({ where: { id: { in: [...ids.equipment] } } }),
    tx.trCase.count({ where: { id: { in: [...ids.cases] } } }),
    tx.trAssignment.count({ where: { id: { in: [...ids.assignments] } } }),
    tx.trFieldUpdate.count({ where: { id: { in: [...ids.fieldUpdates] } } }),
    tx.msMapLayer.count({ where: { id: ids.layer } }),
    tx.msMapFeature.count({ where: { id: { in: [...ids.features] } } }),
    tx.trOperationalUpdate.count({ where: { id: { in: [...ids.updates] } } }),
    tx.trVerification.count({ where: { id: ids.verification } }),
  ]);
}

async function migrateLegacyFixtureIds(tx: Transaction) {
  const legacyBatch = await tx.trAuditLog.findUnique({ where: { id: legacyFixtureIds.batchAudit }, select: { id: true, action: true, targetType: true, targetId: true } });
  const legacyIds = { ...legacyFixtureIds, updates: [...legacyFixtureIds.teamUpdates, ...legacyFixtureIds.equipmentUpdates, ...legacyFixtureIds.featureUpdates] };
  const expected = [legacyIds.teams.length, legacyIds.equipment.length, legacyIds.cases.length, legacyIds.assignments.length, legacyIds.fieldUpdates.length, 1, legacyIds.features.length, legacyIds.updates.length, 1];
  const counts = await fixtureCounts(tx, legacyIds);
  if (!legacyBatch) {
    requireSeed(counts.every(count => count === 0), 'Legacy operations fixture is incomplete.');
    return false;
  }
  requireSeed(legacyBatch.action === 'OPERATIONS_INITIALIZED' && legacyBatch.targetType === 'SEED_BATCH' && legacyBatch.targetId === 'operations-seed-v1', 'Legacy operations fixture provenance mismatch.');
  requireSeed(counts.every((count, index) => count === expected[index]), 'Legacy operations fixture is incomplete.');
  const opaqueIds = { ...operationsFixtureIds, updates: [...operationsFixtureIds.teamUpdates, ...operationsFixtureIds.equipmentUpdates, ...operationsFixtureIds.featureUpdates] };
  requireSeed((await fixtureCounts(tx, opaqueIds)).every(count => count === 0) && !await tx.trAuditLog.findUnique({ where: { id: operationsFixtureIds.batchAudit }, select: { id: true } }), 'Opaque operations fixture IDs already exist.');
  for (const [index, oldId] of legacyFixtureIds.teams.entries()) await tx.msTeam.update({ where: { id: oldId }, data: { id: operationsFixtureIds.teams[index]! } });
  for (const [index, oldId] of legacyFixtureIds.equipment.entries()) await tx.msEquipment.update({ where: { id: oldId }, data: { id: operationsFixtureIds.equipment[index]! } });
  for (const [index, oldId] of legacyFixtureIds.cases.entries()) await tx.trCase.update({ where: { id: oldId }, data: { id: operationsFixtureIds.cases[index]! } });
  for (const [index, oldId] of legacyFixtureIds.assignments.entries()) await tx.trAssignment.update({ where: { id: oldId }, data: { id: operationsFixtureIds.assignments[index]! } });
  for (const [index, oldId] of legacyFixtureIds.fieldUpdates.entries()) await tx.trFieldUpdate.update({ where: { id: oldId }, data: { id: operationsFixtureIds.fieldUpdates[index]! } });
  await tx.msMapLayer.update({ where: { id: legacyFixtureIds.layer }, data: { id: operationsFixtureIds.layer } });
  for (const [index, oldId] of legacyFixtureIds.features.entries()) await tx.msMapFeature.update({ where: { id: oldId }, data: { id: operationsFixtureIds.features[index]! } });
  for (const [index, oldId] of legacyFixtureIds.teamUpdates.entries()) await tx.trOperationalUpdate.update({ where: { id: oldId }, data: { id: operationsFixtureIds.teamUpdates[index]! } });
  for (const [index, oldId] of legacyFixtureIds.equipmentUpdates.entries()) await tx.trOperationalUpdate.update({ where: { id: oldId }, data: { id: operationsFixtureIds.equipmentUpdates[index]! } });
  for (const [index, oldId] of legacyFixtureIds.featureUpdates.entries()) await tx.trOperationalUpdate.update({ where: { id: oldId }, data: { id: operationsFixtureIds.featureUpdates[index]! } });
  await tx.trVerification.update({ where: { id: legacyFixtureIds.verification }, data: { id: operationsFixtureIds.verification } });
  await tx.trAuditLog.update({ where: { id: legacyFixtureIds.batchAudit }, data: { id: operationsFixtureIds.batchAudit, systemActor, targetId: fixtureKey, details: jsonValue({ opaqueIds: true, teams: 3, equipment: 6, cases: 3, assignments: 3, fieldUpdates: 2, features: 4, updates: 13 }) } });
  return true;
}

async function applyOperationsSeed(databaseUrl: string, ca: string | undefined, operatorEmail: string, now = new Date()) {
  const client = new PrismaClient({ adapter: new PrismaPg({ ...databaseConnectionConfig(databaseUrl, ca), max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 }), log: [] });
  const plan = operationsSeedPlan(now);
  const batchAuditId = operationsFixtureIds.batchAudit;
  try {
    return await client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('initial-operations-v1'))`;
      const admin = await tx.msUser.findUnique({ where: { email: operatorEmail }, select: { id: true, role: true, active: true, emailVerified: true } });
      requireSeed(admin?.role === 'ADMIN' && admin.active && admin.emailVerified, 'An active verified ADMIN operator is required.');
      const migrated = await migrateLegacyFixtureIds(tx);
      const ids = {
        teams: plan.teams.map(item => item.id), equipment: plan.equipment.map(item => item.id), cases: plan.cases.map(item => item.id), assignments: plan.assignments.map(item => item.id), fieldUpdates: plan.fieldUpdates.map(item => item.id), layer: plan.layer.id, features: plan.features.map(item => item.id), updates: plan.updates.map(item => item.id), verification: plan.verification.id,
      };
      const counts = await fixtureCounts(tx, ids);
      const expected = [ids.teams.length, ids.equipment.length, ids.cases.length, ids.assignments.length, ids.fieldUpdates.length, 1, ids.features.length, ids.updates.length, 1];
      const batch = await tx.trAuditLog.findUnique({ where: { id: batchAuditId }, select: { id: true, systemActor: true, targetId: true } });
      if (batch) {
        requireSeed(batch.systemActor === systemActor && batch.targetId === fixtureKey && counts.every((count, index) => count === expected[index]), 'Existing operations fixture is incomplete.');
        return { mode: migrated ? 'MIGRATED_EXISTING' : 'VERIFIED_EXISTING', created: 0 };
      }
      requireSeed(counts.every(count => count === 0), 'Partial operations seed data already exists.');
      requireSeed(await tx.trCase.count({ where: { number: { in: plan.cases.map(item => item.number) } } }) === 0, 'An operational case number already exists.');
      requireSeed(await tx.msMapLayer.count({ where: { provider: plan.layer.provider, name: plan.layer.name, version: plan.layer.version } }) === 0, 'The operational map layer already exists.');
      for (const item of plan.teams) await tx.msTeam.create({ data: item });
      for (const item of plan.equipment) await tx.msEquipment.create({ data: item });
      await tx.msMapLayer.create({ data: { ...plan.layer, features: { create: plan.features.map(item => ({ id: item.id, sourceId: item.sourceId, kind: item.kind, name: item.name, geometry: jsonValue({ type: 'Point', coordinates: [item.longitude, item.latitude] }), attributes: jsonValue({ operational: true }) })) } } });
      for (const item of plan.cases) await tx.trCase.create({ data: item });
      for (const item of plan.assignments) await tx.trAssignment.create({ data: { ...item, assigningAdminId: admin.id } });
      for (const item of plan.fieldUpdates) await tx.trFieldUpdate.create({ data: { ...item, recorderId: admin.id } });
      await tx.trVerification.create({ data: { ...plan.verification, decidingAdminId: admin.id } });
      await tx.trCase.update({ where: { id: plan.cases[2]!.id }, data: { completionFieldUpdateId: plan.fieldUpdates[1]!.id } });
      for (const item of plan.updates) await tx.trOperationalUpdate.create({ data: { ...item, recorderId: admin.id, notes: reason } });
      await tx.trAuditLog.create({ data: { id: batchAuditId, actorId: admin.id, systemActor, action: 'OPERATIONS_INITIALIZED', targetType: 'SEED_BATCH', targetId: fixtureKey, reason, details: jsonValue({ opaqueIds: true, teams: plan.teams.length, equipment: plan.equipment.length, cases: plan.cases.length, assignments: plan.assignments.length, fieldUpdates: plan.fieldUpdates.length, features: plan.features.length, updates: plan.updates.length }) } });
      return { mode: 'APPLIED', created: expected.reduce((total, count) => total + count, 0), counts: { teams: plan.teams.length, equipment: plan.equipment.length, cases: plan.cases.length, assignments: plan.assignments.length, fieldUpdates: plan.fieldUpdates.length, features: plan.features.length, updates: plan.updates.length } };
    }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 60000 });
  } finally { await client.$disconnect(); }
}

export async function runOperationsSeed(args: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'confirm-current-database': { type: 'boolean', default: false }, 'operator-email': { type: 'string' } }, allowPositionals: false, strict: true });
  const plan = operationsSeedPlan();
  if (!values.apply) return { mode: 'DRY_RUN', writes: 0, planned: { teams: plan.teams.length, equipment: plan.equipment.length, cases: plan.cases.length, assignments: plan.assignments.length, fieldUpdates: plan.fieldUpdates.length, features: plan.features.length, updates: plan.updates.length }, prerequisite: 'Apply requires --apply --confirm-current-database --operator-email <active-admin-email>.' };
  requireSeed(values['confirm-current-database'], 'Apply requires --confirm-current-database.');
  const operatorEmail = values['operator-email']?.trim().toLowerCase();
  requireSeed(operatorEmail, 'Apply requires --operator-email.');
  const config = guardOperationsSeed(env);
  return applyOperationsSeed(config.databaseUrl, config.ca, operatorEmail);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runOperationsSeed(process.argv.slice(2), process.env), null, 2)); }
  catch (error) { console.error(error instanceof OperationsSeedError ? error.message : 'Operations seeding failed; no credentials or operational data were logged.'); process.exitCode = 1; }
}
