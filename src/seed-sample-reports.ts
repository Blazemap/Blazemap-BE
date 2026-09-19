import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import type { PrismaClient } from './generated/prisma/client.js';
import { db, disconnect } from './config/db.js';
import { reportSchema } from './types/index.js';
import { fingerprint } from './utils/index.js';
import { audit, lockedActor, verifiedRegion } from './modules/admin/access.js';
import { triageReports } from './modules/reports/triage.js';
import { testIdentities } from './seed-test-accounts.js';

export const disclaimer = 'Sample report for workflow testing; not a verified real incident.';
const prefix = 'sample-report-v1-';
const sites = [
  ['Kubu Raya', -0.32, 109.48, 'a thin smoke column above scrub beside a drainage canal'],
  ['Ketapang', -1.82, 110.18, 'small flames along dry vegetation beside an unpaved track'],
  ['Sintang', 0.12, 111.48, 'a burning smell near a plantation access road without a visible source'],
  ['Kapuas', -2.62, 114.32, 'light smoke drifting across low vegetation near a canal'],
  ['Pulang Pisau', -2.78, 114.08, 'patches of flame in dry grass away from buildings'],
  ['Katingan', -1.82, 113.28, 'an intermittent burning smell near a riverbank path'],
  ['Banjar', -3.28, 115.08, 'a narrow smoke plume above roadside scrub'],
  ['Paser', -1.72, 116.08, 'small flames at the edge of a cleared patch'],
  ['Kutai Kartanegara', -0.32, 116.78, 'a burning smell along a rural access track without visible flames'],
  ['Bulungan', 2.62, 117.18, 'diffuse smoke above a patch of dry vegetation'],
] as const;
const owners = [0, 0, 1, 1, 2, 2, 3, 3, 4, 5];
export function samplePayloads(now = new Date()) {
  const citizens = testIdentities.filter(identity => identity.role === 'USER');
  return sites.map(([place, latitude, longitude, observation], index) => ({
    email: citizens[owners[index]!]!.email,
    payload: reportSchema.parse({ observationTypes: [['SMOKE', 'FLAME', 'BURNING_SMELL'][index % 3]], observedAt: new Date(now.getTime() - (index + 1) * 600000).toISOString(), locationMode: 'INCIDENT_ESTIMATE', latitude, longitude, accuracyMeters: null, regionId: null, locationDescription: `Arbitrary simulated map point in the ${place} area, Kalimantan; not a surveyed incident location.`, description: `In this simulated scenario, a report would describe ${observation}. ${disclaimer}`, attachmentIds: [], idempotencyKey: `${prefix}${String(index + 1).padStart(2, '0')}` }),
  }));
}
export function sampleFlags(args: string[]) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean' }, 'confirm-sample-reports': { type: 'boolean' } } });
  if (!!values.apply !== !!values['confirm-sample-reports']) throw new Error('Both write flags required');
  return !!values.apply;
}
export async function seedSampleReports(client: PrismaClient, apply = false, now = new Date()) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sample-report-seeder'))`;
    const identities = testIdentities.filter(identity => identity.role === 'USER');
    const users = await tx.msUser.findMany({ where: { email: { in: identities.map(identity => identity.email) } }, select: { id: true, email: true, name: true, role: true, active: true, emailVerified: true, canConfirmIncidents: true, canPublishInformation: true, accounts: { select: { accountId: true, providerId: true } } }, take: 7 });
    if (users.length !== 6) throw new Error('Expected six existing citizen fixtures');
    const evidence = await tx.trAuditLog.findMany({ where: { systemActor: 'test-account-seeder', action: 'TEST_ACCOUNT_CREATED', targetType: 'USER', targetId: { in: users.map(user => user.id) } }, take: 7 });
    for (const identity of identities) {
      const user = users.find(user => user.email === identity.email)!;
      const records = evidence.filter(record => record.targetId === user.id);
      if (user.name !== identity.name || user.role !== 'USER' || !user.active || !user.emailVerified || user.canConfirmIncidents || user.canPublishInformation || user.accounts.length !== 1 || user.accounts[0]?.providerId !== 'credential' || user.accounts[0]?.accountId !== user.id || records.length !== 1 || !isDeepStrictEqual(records[0]?.details, { email: identity.email, role: 'USER', emailVerified: true, verificationBasis: 'EXPLICIT_TEST_FIXTURE_BYPASS', fictionalIdentity: true, canConfirmIncidents: false, canPublishInformation: false })) throw new Error('Fixture identity or audit mismatch');
      await lockedActor(tx, user);
    }
    const before = await tx.trReport.findMany({ orderBy: { id: 'asc' }, take: 10001 });
    if (before.length > 10000) throw new Error('Preservation verification bound exceeded');
    const counts = async () => ({ users: await tx.msUser.count(), accounts: await tx.trAccount.count(), reports: await tx.trReport.count(), cases: await tx.trCase.count(), verifications: await tx.trVerification.count(), attachments: await tx.trAttachment.count() });
    const beforeCounts = await counts();
    const planned = samplePayloads(now);
    const existing = before.filter(row => row.idempotencyKey.startsWith(prefix));
    if (existing.length > 10 || existing.some(row => !planned.some(item => item.payload.idempotencyKey === row.idempotencyKey))) throw new Error('Unexpected sample keys');
    let created = 0;
    const output = [];
    for (const item of planned) {
      const user = users.find(user => user.email === item.email)!;
      const matches = existing.filter(row => row.idempotencyKey === item.payload.idempotencyKey);
      if (matches.length > 1) throw new Error('Duplicate sample key');
      const prior = matches[0];
      const data = reportSchema.parse({ ...item.payload, ...(prior ? { observedAt: prior.observedAt.toISOString() } : {}) });
      const hash = fingerprint({ ...data, observationTypes: [...data.observationTypes].sort(), attachmentIds: [...data.attachmentIds].sort() });
      const details = { synthetic: true, fictionalIdentity: true, coordinatesSimulated: true, incidentEstimateConfirmedForFixtureOnly: true, governmentConfirmation: false, idempotencyKey: data.idempotencyKey, payloadHash: hash, reporterEmail: user.email, observedAt: data.observedAt };
      let report = prior;
      if (prior) {
        const { attachmentIds: _attachments, observedAt: _time, ...fields } = data;
        if (prior.reporterId !== user.id || prior.payloadHash !== hash || prior.caseId !== null || prior.reviewStatus !== 'NEW' || !prior.number.startsWith('R-') || Object.entries(fields).some(([key, value]) => !isDeepStrictEqual(prior[key as keyof typeof prior], value))) throw new Error('Existing sample payload mismatch');
        const audits = await tx.trAuditLog.findMany({ where: { systemActor: 'sample-report-seeder', action: 'SAMPLE_REPORT_CREATED', targetType: 'REPORT', targetId: prior.id }, take: 2 });
        if (audits.length !== 1 || !isDeepStrictEqual(audits[0]?.details, details) || await tx.trAttachment.count({ where: { reportId: prior.id } }) || await tx.trReportUpdate.count({ where: { reportId: prior.id } })) throw new Error('Existing sample provenance mismatch');
      } else if (apply) {
        await verifiedRegion(tx, data.regionId);
        const { attachmentIds: _attachments, ...fields } = data;
        report = await tx.trReport.create({ data: { ...fields, observedAt: new Date(data.observedAt), reporterId: user.id, payloadHash: hash, number: `R-${randomUUID()}` } });
        await audit(tx, user.id, 'REPORT_CREATED', 'REPORT', report.id);
        await tx.trAuditLog.create({ data: { systemActor: 'sample-report-seeder', action: 'SAMPLE_REPORT_CREATED', targetType: 'REPORT', targetId: report.id, reason: disclaimer, details } });
        created++;
      }
      const candidate = report ?? { ...data, id: data.idempotencyKey, number: 'R-preview', observedAt: new Date(data.observedAt) };
      const triage = (await triageReports([candidate], client)).get(candidate.id)!;
      if (triage.level !== 'UNKNOWN' || !triage.reasonCodes.includes('DEMO_EXCLUDED') || triage.satelliteMatch || triage.settlementMatch) throw new Error('Sample triage exclusion failed');
      output.push({ email: user.email, number: report?.number ?? null, idempotencyKey: data.idempotencyKey, triage: triage.level });
    }
    const afterCounts = await counts();
    const preserved = await tx.trReport.findMany({ where: { id: { in: before.map(row => row.id) } }, orderBy: { id: 'asc' }, take: 10001 });
    if (!isDeepStrictEqual(before, preserved) || !isDeepStrictEqual(afterCounts, { ...beforeCounts, reports: beforeCounts.reports + created })) throw new Error('Preservation verification failed');
    if (apply && await tx.trReport.count({ where: { idempotencyKey: { startsWith: prefix } } }) !== 10) throw new Error('Expected exactly ten samples');
    return { dryRun: !apply, created, existing: existing.length, planned: planned.length, beforeCounts, afterCounts, existingReportsUnchanged: true, reports: output };
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 60000 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await seedSampleReports(db(), sampleFlags(process.argv.slice(2))))); }
  catch { console.error('Sample report seed refused or failed; check flags, fixture provenance, collisions and database availability. No credentials were read or printed.'); process.exitCode = 1; }
  finally { await disconnect(); }
}
