import { createHash } from 'node:crypto';
import { access, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { db, disconnect } from './config/db.js';
import { demoAreas } from './seed-areas.js';
import { testIdentities } from './seed-test-accounts.js';
import type { Prisma } from './generated/prisma/client.js';

type Row = Record<string, unknown>;
class CleanupBlocked extends Error {}
export function guard(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CleanupBlocked(message);
}
export function cleanupOptions(args: string[]) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'confirm-seeded-records-only': { type: 'boolean', default: false } }, allowPositionals: false });
  guard(!values.apply || values['confirm-seeded-records-only'], 'Apply requires --confirm-seeded-records-only');
  return values;
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const caseNumbers = Array.from({ length: 10 }, (_, i) => `DEMO-FIRE-V1-${String(i + 1).padStart(2, '0')}`);
const reportNumbers = Array.from({ length: 10 }, (_, i) => `[DEMO]-PHOTO-V1-${String(i + 1).padStart(2, '0')}`);
const layerNames = ['[DEMO] Simulated confirmed case areas', '[DEMO] Simulated fire areas'];
const digest = (rows: Row[]) => createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');
export function assertNoReferences(rows: Row[], column: string, ids: Set<unknown>, allowed: Set<unknown>, label: string) {
  guard(!rows.some(row => ids.has(row[column]) && !allowed.has(row.id)), `Non-fixture or immutable reference: ${label}`);
}
async function snapshot(tx: Prisma.TransactionClient, tables: string[]) {
  const result: Record<string, Row[]> = {};
  for (const table of tables) result[table] = await tx.$queryRawUnsafe<Row[]>(`SELECT to_jsonb(t) AS row FROM public.${quote(table)} t`).then(rows => rows.map(row => row.row as Row));
  return result;
}
export async function cleanup(args: string[]) {
  const options = cleanupOptions(args);
  const file = resolve('.env.test-accounts');
  const revoked = resolve('.env.test-accounts.revoked');
  let fileExists = false;
  try { await access(file); fileExists = true; } catch (error) { guard((error as NodeJS.ErrnoException).code === 'ENOENT', 'Cannot inspect credential file'); }
  if (fileExists) {
    let destinationExists = false;
    try { await access(revoked); destinationExists = true; } catch (error) { guard((error as NodeJS.ErrnoException).code === 'ENOENT', 'Cannot inspect revoked credential destination'); }
    guard(!destinationExists, 'Revoked credential destination already exists; refusing overwrite');
  }
  const result = await db().$transaction(async tx => {
    await tx.$executeRawUnsafe(options.apply ? 'SET LOCAL lock_timeout = \'10s\'' : 'SET TRANSACTION READ ONLY');
    const tables = (await tx.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`).map(row => row.tablename);
    if (options.apply) await tx.$executeRawUnsafe(`LOCK TABLE ${tables.map(table => `public.${quote(table)}`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    const before = await snapshot(tx, tables);
    const rows = (table: string) => before[table] ?? [];
    const selected: Record<string, Set<unknown>> = {};
    const select = (table: string, records: Row[]) => { selected[table] = new Set(records.map(row => row.id)); return records; };
    const audits = rows('TrAuditLog');
    const proof = (row: Row, actor: string, action: string, type: string) => audits.filter(audit => audit.targetId === row.id && audit.systemActor === actor && audit.action === action && audit.targetType === type);
    const cases = select('TrCase', rows('TrCase').filter(row => caseNumbers.includes(String(row.number))));
    for (const row of cases) {
      const index = caseNumbers.indexOf(String(row.number));
      guard(row.title === `[DEMO] Simulated confirmed fire ${index + 1}` && row.priorityReason === 'DEMO simulation; not a real government confirmation.' && proof(row, 'demo-case-seeder-v1', 'DEMO_CASE_CREATED', 'CASE').length === 1, 'Case provenance mismatch');
      guard(row.version === 1 && row.contextRevision === 1 && row.perimeterRevision === 0 && row.perimeter === null && row.latestAnalysisId === null && row.regionId === null && row.closedAt === null && row.verificationStatus === 'CONFIRMED_FIRE' && row.handlingStatus === 'MONITORING', 'Case changed since seed');
    }
    const users = select('MsUser', rows('MsUser').filter(row => testIdentities.some(identity => identity.email === row.email)));
    for (const row of users) {
      const identity = testIdentities.find(identity => identity.email === row.email)!;
      const evidence = proof(row, 'test-account-seeder', 'TEST_ACCOUNT_CREATED', 'USER');
      guard(row.name === identity.name && row.role === identity.role && row.canConfirmIncidents === false && row.canPublishInformation === false && evidence.length === 1, 'User provenance mismatch');
      const details = evidence[0]!.details as Row;
      guard(details.email === identity.email && details.role === identity.role && details.verificationBasis === 'EXPLICIT_TEST_FIXTURE_BYPASS', 'User audit provenance mismatch');
    }
    const reports = select('TrReport', rows('TrReport').filter(row => reportNumbers.includes(String(row.number))));
    for (const row of reports) {
      const index = reportNumbers.indexOf(String(row.number));
      guard(proof(row, 'demo-photo-seeder-v1', 'DEMO_REPORT_CREATED', 'REPORT').length === 1 && row.idempotencyKey === `demo-photo-reports-v1-${String(index + 1).padStart(2, '0')}` && row.locationDescription === `[DEMO] Lokasi simulasi ${index + 1}; koordinat 0,0 bukan lokasi kejadian.` && row.description === `[DEMO] Ilustrasi sampel, bukan bukti atau laporan warga nyata. Skenario latihan ${index + 1}; jenis pengamatan dan waktu adalah simulasi. Foto orang dengan ponsel di hutan tidak membuktikan kebakaran dan bukan identitas pelapor.` && row.reviewStatus === 'NEW', 'Report provenance mismatch');
    }
    const layers = select('MsMapLayer', rows('MsMapLayer').filter(row => row.provider === 'DEMO' && row.version === '1' && layerNames.includes(String(row.name))));
    const fixtures = demoAreas();
    for (const row of layers) {
      const confirmed = row.name === layerNames[0];
      guard(row.sourceUrl === (confirmed ? 'urn:blazemap:demo:confirmed-areas:v1' : 'urn:blazemap:demo:fire-areas:v1') && row.license === 'Synthetic test fixture' && row.kind === 'DESIGNATED_LOCATION' && row.verifiedAt === null, 'Layer provenance mismatch');
    }
    const features = select('MsMapFeature', rows('MsMapFeature').filter(row => selected.MsMapLayer!.has(row.layerId)));
    for (const row of features) {
      const fixture = fixtures.find(fixture => fixture.id === row.sourceId);
      const attributes = row.attributes as Row;
      guard(fixture && row.name === fixture.properties.name && row.kind === 'DESIGNATED_LOCATION' && row.regionId === null && isDeepStrictEqual(row.geometry, fixture.geometry) && Object.entries(fixture.properties).every(([key, value]) => isDeepStrictEqual(attributes[key], value)), 'Polygon provenance mismatch');
      const layer = layers.find(layer => layer.id === row.layerId)!;
      if (layer.name === layerNames[0]) guard(selected.TrCase!.has(attributes.caseId) && attributes.scenarioStatus === 'SIMULATED_CONFIRMED_FIRE', 'Polygon case provenance mismatch');
    }
    const accounts = select('TrAccount', rows('TrAccount').filter(row => selected.MsUser!.has(row.userId)));
    for (const row of accounts) guard(row.providerId === 'credential' && row.accountId === row.userId && !row.accessToken && !row.refreshToken && !row.idToken, 'Non-fixture linked account');
    select('TrSession', rows('TrSession').filter(row => selected.MsUser!.has(row.userId)));
    const planned = Object.fromEntries(Object.entries(selected).map(([table, ids]) => [table, ids.size]));
    const fks = await tx.$queryRaw<{ source: string; target: string; column: string; targetColumn: string; width: number }[]>`SELECT s.relname AS source, t.relname AS target, a.attname AS column, b.attname AS "targetColumn", cardinality(c.conkey) AS width FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_class t ON t.oid=c.confrelid JOIN pg_namespace n ON n.oid=s.relnamespace JOIN pg_attribute a ON a.attrelid=s.oid AND a.attnum=c.conkey[1] JOIN pg_attribute b ON b.attrelid=t.oid AND b.attnum=c.confkey[1] WHERE c.contype='f' AND n.nspname='public'`;
    console.log(JSON.stringify({ mode: options.apply ? 'PRE_APPLY' : 'DRY_RUN', planned, baseline: Object.fromEntries(tables.map(table => [table, rows(table).length])), provenance: { cases: cases.map(row => row.number), users: users.map(row => row.email), reports: reports.map(row => row.number), layers: layers.map(row => row.name), polygons: features.map(row => row.sourceId) }, foreignKeysInspected: fks.length }));
    for (const fk of fks) {
      if (!selected[fk.target]?.size) continue;
      guard(fk.width === 1 && fk.targetColumn === 'id', 'Unsupported foreign key; manual review required');
      assertNoReferences(rows(fk.source), fk.column, selected[fk.target]!, selected[fk.source] ?? new Set(), `${fk.source}.${fk.column}`);
    }
    const preserved = Object.fromEntries(tables.map(table => [table, rows(table).filter(row => !selected[table]?.has(row.id))]));
    if (!options.apply) return { mode: 'DRY_RUN', writes: 0, planned, referencesSafe: true };
    const deleted: Record<string, number> = {};
    for (const table of ['TrSession', 'TrAccount', 'TrReport', 'MsMapFeature', 'MsMapLayer', 'TrCase', 'MsUser']) {
      const ids = [...selected[table]!];
      deleted[table] = ids.length ? await tx.$executeRawUnsafe(`DELETE FROM public.${quote(table)} WHERE id = ANY($1::text[])`, ids) : 0;
      guard(deleted[table] === ids.length, 'Deletion count mismatch');
    }
    const after = await snapshot(tx, tables);
    for (const table of tables) guard(digest(after[table]!) === digest(preserved[table]!), `Preservation check failed: ${table}`);
    await tx.trAuditLog.create({ data: { systemActor: 'seed-cleanup', action: 'SEEDED_RECORDS_DELETED', targetType: 'SEED_BATCH', targetId: 'known-fixtures-v1', reason: 'User authorized Data dan akun uji cleanup; exact seed provenance only; no replacement or government verification created.', details: { requestedCounts: planned, deletedCounts: deleted, preservedCounts: Object.fromEntries(tables.map(table => [table, preserved[table]!.length])), deletedIds: Object.fromEntries(Object.entries(selected).map(([table, ids]) => [table, [...ids] as string[]])), credentialsFile: fileExists ? '.env.test-accounts.revoked pending post-commit rename' : 'absent' } } });
    return { mode: 'APPLIED', deleted, remainingSelected: Object.fromEntries(Object.keys(selected).map(table => [table, after[table]!.filter(row => selected[table]!.has(row.id)).length])), preserved: Object.fromEntries(tables.map(table => [table, preserved[table]!.length])), allPreservedRowsHashMatched: true, cleanupAuditAdded: 1 };
  }, { isolationLevel: 'Serializable', timeout: 120000, maxWait: 15000 });
  console.log(JSON.stringify(result));
  if (options.apply && fileExists) {
    try { await rename(file, revoked); console.log(JSON.stringify({ credentialsFile: '.env.test-accounts.revoked', renamed: true })); }
    catch { throw new CleanupBlocked('DATABASE CLEANUP COMMITTED; credential file rename failed; manually revoke filename'); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await cleanup(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof CleanupBlocked ? error.message : 'Cleanup failed; no credentials logged. Inspect transaction outcome before retrying.', error instanceof CleanupBlocked ? '' : { category: error instanceof Error ? ['certificate', 'timeout', 'connect', 'read-only', 'transaction', 'serialize', 'BigInt', 'Database'].filter(term => error.message.toLowerCase().includes(term.toLowerCase())) : [], name: error instanceof Error ? error.name : 'unknown', code: error && typeof error === 'object' && 'code' in error ? error.code : null, sqlState: error && typeof error === 'object' && 'meta' in error ? (error.meta as { code?: string })?.code : null }); process.exitCode = 1; }
  finally { await disconnect(); }
}
