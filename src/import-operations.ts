import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { databaseConnectionConfig } from './config/db.js';
import { env } from './config/env.js';
import { PrismaClient } from './generated/prisma/client.js';
import { fingerprint, jsonValue } from './utils/index.js';

const importer = 'production-operations-importer-v1';
const synthetic = /(^|\W)(demo|sample|dummy|fake|training|latihan|simulasi|contoh)(\W|$)/i;
const realText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).refine(value => !synthetic.test(value), 'Synthetic labels are not allowed in production imports');
const externalId = z.string().trim().min(2).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const teamCondition = z.enum(['AVAILABLE', 'DEPLOYED', 'UNAVAILABLE', 'UNKNOWN']);
const equipmentCondition = z.enum(['AVAILABLE', 'IN_USE', 'DAMAGED', 'UNAVAILABLE', 'UNKNOWN']);
const featureSchema = z.discriminatedUnion('kind', [
  z.strictObject({ externalId, name: realText(2, 200), kind: z.literal('ROAD'), latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), condition: z.enum(['PASSABLE', 'RESTRICTED', 'IMPASSABLE']) }),
  z.strictObject({ externalId, name: realText(2, 200), kind: z.literal('WATER_SOURCE'), latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), condition: z.enum(['WATER_AVAILABLE', 'WATER_UNAVAILABLE']) }),
]);
const importSchema = z.strictObject({
  source: realText(5, 300),
  reason: realText(5, 2000),
  observedAt: z.iso.datetime({ offset: true }),
  teams: z.array(z.strictObject({ externalId, name: realText(2, 200), organization: realText(2, 200).nullable().optional(), condition: teamCondition })).max(500).default([]),
  equipment: z.array(z.strictObject({ externalId, name: realText(2, 200), kind: realText(2, 100), teamExternalId: externalId, condition: equipmentCondition })).max(2000).default([]),
  features: z.array(featureSchema).max(2000).default([]),
}).superRefine((value, context) => {
  if (!value.teams.length && !value.equipment.length && !value.features.length) context.addIssue({ code: 'custom', message: 'At least one operational record is required' });
  const ids = new Set<string>();
  for (const [group, rows] of [['teams', value.teams], ['equipment', value.equipment], ['features', value.features]] as const) for (const [index, row] of rows.entries()) {
    const key = `${group}:${row.externalId}`;
    if (ids.has(key)) context.addIssue({ code: 'custom', path: [group, index, 'externalId'], message: 'External ID must be unique within its group' });
    ids.add(key);
  }
  const teams = new Set(value.teams.map(team => team.externalId));
  for (const [index, item] of value.equipment.entries()) if (!teams.has(item.teamExternalId)) context.addIssue({ code: 'custom', path: ['equipment', index, 'teamExternalId'], message: 'Equipment owner team is missing from this import' });
});
export type OperationsImport = z.infer<typeof importSchema>;
export function parseOperationsImport(value: unknown, now = new Date()) {
  const parsed = importSchema.parse(value);
  if (Date.parse(parsed.observedAt) > now.getTime() + 300000) throw new Error('Observation time cannot be in the future');
  return parsed;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const recordId = (kind: string, external: string) => `ops-${kind}-${hash(external).slice(0, 24)}`;
const updateKey = (source: string, observedAt: string, kind: string, external: string) => `ops-import:${hash(`${source}:${observedAt}:${kind}:${external}`).slice(0, 48)}`;
async function importedTarget(tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0], targetType: string, targetId: string) {
  return tx.trAuditLog.findFirst({ where: { systemActor: importer, targetType, targetId }, select: { id: true } });
}
async function conditionUpdate(tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0], actorId: string, input: OperationsImport, subjectType: 'TEAM' | 'EQUIPMENT' | 'FEATURE', subjectId: string, external: string, condition: string) {
  const idempotencyKey = updateKey(input.source, input.observedAt, subjectType, external);
  const payloadHash = fingerprint({ subjectType, subjectId, condition, source: input.source, observedAt: input.observedAt, reason: input.reason });
  const existing = await tx.trOperationalUpdate.findUnique({ where: { idempotencyKey }, select: { payloadHash: true } });
  if (existing) { if (existing.payloadHash !== payloadHash) throw new Error('Operational update idempotency conflict'); return false; }
  await tx.trOperationalUpdate.create({ data: { recorderId: actorId, subjectType, ...(subjectType === 'TEAM' ? { teamId: subjectId } : subjectType === 'EQUIPMENT' ? { equipmentId: subjectId } : { featureId: subjectId }), condition, source: input.source, observedAt: new Date(input.observedAt), notes: input.reason, idempotencyKey, payloadHash } });
  return true;
}
export async function importOperations(client: PrismaClient, actorEmail: string, input: OperationsImport) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('production-operations-import-v1'))`;
    const actor = await tx.msUser.findFirst({ where: { email: actorEmail.toLowerCase(), role: 'ADMIN', active: true, emailVerified: true }, select: { id: true } });
    if (!actor) throw new Error('An active verified ADMIN operator is required');
    const sourceHash = hash(input.source).slice(0, 24);
    const layer = input.features.length ? await tx.msMapLayer.upsert({ where: { provider_name_version: { provider: 'Blazemap verified import', name: `Operational import ${sourceHash}`, version: '1' } }, update: { sourceDate: new Date(input.observedAt), verifiedAt: new Date() }, create: { provider: 'Blazemap verified import', name: `Operational import ${sourceHash}`, version: '1', kind: 'DESIGNATED_LOCATION', sourceUrl: `urn:blazemap:operations:${sourceHash}`, license: 'Restricted operational data', attribution: input.source, coverage: 'Operator-supplied point records; access points do not establish full-route usability', sourceDate: new Date(input.observedAt), verifiedAt: new Date() } }) : null;
    const teamIds = new Map<string, string>();
    let created = 0, updated = 0, statusUpdates = 0;
    for (const item of input.teams) {
      const id = recordId('team', item.externalId), existing = await tx.msTeam.findUnique({ where: { id } });
      if (existing && !await importedTarget(tx, 'TEAM', id)) throw new Error(`Team collision for ${item.externalId}`);
      const payloadHash = fingerprint(item);
      if (existing) { await tx.msTeam.update({ where: { id }, data: { name: item.name, organization: item.organization ?? null, active: true, version: { increment: 1 }, payloadHash, updatedAt: new Date() } }); updated++; }
      else { await tx.msTeam.create({ data: { id, name: item.name, organization: item.organization ?? null, active: true, version: 1, payloadHash } }); created++; }
      teamIds.set(item.externalId, id);
      statusUpdates += Number(await conditionUpdate(tx, actor.id, input, 'TEAM', id, item.externalId, item.condition));
      await tx.trAuditLog.create({ data: { actorId: actor.id, systemActor: importer, action: existing ? 'OPERATIONS_TEAM_UPDATED' : 'OPERATIONS_TEAM_CREATED', targetType: 'TEAM', targetId: id, reason: input.reason, details: jsonValue({ externalId: item.externalId, source: input.source, observedAt: input.observedAt, payloadHash }) } });
    }
    for (const item of input.equipment) {
      const id = recordId('equipment', item.externalId), teamId = teamIds.get(item.teamExternalId)!;
      const existing = await tx.msEquipment.findUnique({ where: { id } });
      if (existing && !await importedTarget(tx, 'EQUIPMENT', id)) throw new Error(`Equipment collision for ${item.externalId}`);
      const payloadHash = fingerprint(item);
      if (existing) { await tx.msEquipment.update({ where: { id }, data: { name: item.name, kind: item.kind, teamId, active: true, version: { increment: 1 }, payloadHash, updatedAt: new Date() } }); updated++; }
      else { await tx.msEquipment.create({ data: { id, name: item.name, kind: item.kind, teamId, active: true, version: 1, payloadHash } }); created++; }
      statusUpdates += Number(await conditionUpdate(tx, actor.id, input, 'EQUIPMENT', id, item.externalId, item.condition));
      await tx.trAuditLog.create({ data: { actorId: actor.id, systemActor: importer, action: existing ? 'OPERATIONS_EQUIPMENT_UPDATED' : 'OPERATIONS_EQUIPMENT_CREATED', targetType: 'EQUIPMENT', targetId: id, reason: input.reason, details: jsonValue({ externalId: item.externalId, teamExternalId: item.teamExternalId, source: input.source, observedAt: input.observedAt, payloadHash }) } });
    }
    for (const item of input.features) {
      const id = recordId('feature', item.externalId), existing = await tx.msMapFeature.findUnique({ where: { id } });
      if (existing && !await importedTarget(tx, 'FEATURE', id)) throw new Error(`Feature collision for ${item.externalId}`);
      const data = { layerId: layer!.id, sourceId: item.externalId, kind: item.kind, name: item.name, geometry: jsonValue({ type: 'Point', coordinates: [item.longitude, item.latitude] }), attributes: jsonValue({ externalId: item.externalId, source: input.source, observedAt: input.observedAt, pointMeaning: item.kind === 'ROAD' ? 'ACCESS_POINT' : 'WATER_SOURCE_POINT' }) };
      if (existing) { await tx.msMapFeature.update({ where: { id }, data }); updated++; }
      else { await tx.msMapFeature.create({ data: { id, ...data } }); created++; }
      statusUpdates += Number(await conditionUpdate(tx, actor.id, input, 'FEATURE', id, item.externalId, item.condition));
      await tx.trAuditLog.create({ data: { actorId: actor.id, systemActor: importer, action: existing ? 'OPERATIONS_FEATURE_UPDATED' : 'OPERATIONS_FEATURE_CREATED', targetType: 'FEATURE', targetId: id, reason: input.reason, details: jsonValue({ externalId: item.externalId, source: input.source, observedAt: input.observedAt, latitude: item.latitude, longitude: item.longitude }) } });
    }
    await tx.trAuditLog.create({ data: { actorId: actor.id, systemActor: importer, action: 'OPERATIONS_IMPORT_COMPLETED', targetType: 'OPERATIONS_IMPORT', targetId: updateKey(input.source, input.observedAt, 'BATCH', 'all'), reason: input.reason, details: jsonValue({ source: input.source, observedAt: input.observedAt, created, updated, statusUpdates }) } });
    return { created, updated, statusUpdates };
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 120000 });
}
export async function runOperationsImport(args: string[], read = readFile) {
  const { values } = parseArgs({ args, options: { file: { type: 'string' }, apply: { type: 'boolean', default: false }, 'confirm-production-operations': { type: 'boolean', default: false }, 'operator-email': { type: 'string' } }, allowPositionals: false, strict: true });
  if (!values.file) throw new Error('Use --file <operations.json>');
  const file = resolve(values.file);
  const input = parseOperationsImport(JSON.parse(await read(file, 'utf8')));
  if (!values.apply) return { mode: 'DRY_RUN', writes: 0, file, source: input.source, observedAt: input.observedAt, teams: input.teams.length, equipment: input.equipment.length, features: input.features.length };
  if (!values['confirm-production-operations'] || !values['operator-email']) throw new Error('Apply requires --confirm-production-operations and --operator-email');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is unavailable');
  const client = new PrismaClient({ adapter: new PrismaPg({ ...databaseConnectionConfig(env.DATABASE_URL, env.DATABASE_CA_PEM), max: 2, connectionTimeoutMillis: 5000, statement_timeout: 30000 }), log: [] });
  try { return { mode: 'APPLIED', ...await importOperations(client, values['operator-email'], input) }; }
  finally { await client.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runOperationsImport(process.argv.slice(2)), null, 2)); }
  catch { console.error('Operations import failed. No credentials or record contents were logged. Run dry-run first and inspect source, timestamps, coordinates, relationships, and collisions.'); process.exitCode = 1; }
}
