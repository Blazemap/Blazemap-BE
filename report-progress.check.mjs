import assert from 'node:assert/strict';
import { caseSchema, reviewSchema, verificationSchema, casePatchSchema } from './src/types/index.ts';
import { addReportProgress, getReport } from './src/modules/reports/reports.service.ts';

assert.equal(reviewSchema.safeParse({ reviewStatus: 'UNDER_REVIEW', reason: 'Review started', reporterMessage: 'Checking the submitted observation.' }).success, true);
assert.equal(reviewSchema.safeParse({ reviewStatus: 'UNDER_REVIEW', reason: 'Review started' }).success, false);
assert.equal(verificationSchema.safeParse({ outcome: 'INCONCLUSIVE', reason: 'Internal assessment', authorityReference: 'Restricted mandate', fieldUpdateId: 'field', version: 1, reporterMessage: 'The inspection did not establish a conclusion.' }).success, true);
assert.equal(casePatchSchema.safeParse({ handlingStatus: 'CHECK_SCHEDULED', reason: 'Internal scheduling basis', version: 1, reporterMessage: 'An inspection has been scheduled.' }).success, true);
assert.equal(caseSchema.safeParse({ title: 'Reported observation R-12', reason: 'Opened case from citizen report R-12', latitude: null, longitude: null, regionId: null }).success, true);
assert.equal(reviewSchema.safeParse({ reviewStatus: 'DECLINED', reason: 'Duplicate observation', reporterMessage: 'This duplicate report was declined.' }).success, true);
assert.equal(reviewSchema.safeParse({ reviewStatus: 'DECLINED', reason: 'Duplicate observation' }).success, false);
const owner = { id: 'owner', role: 'USER' };
let query;
const client = { trReport: { findFirst: async q => {
  query = q;
  if (q.where.reporterId !== owner.id) return null;
  return { id: 'report', number: 'R-1', progress: [{ id: 'progress', stage: 'UNDER_REVIEW', description: 'Checking the observation.', createdAt: new Date('2026-09-01'), attachments: [{ id: 'evidence', filename: 'inspection.jpg', contentType: 'image/jpeg', size: 1024 }], actorId: 'private-admin', actor: { email: 'private@example.invalid' } }] };
} } };
const result = await getReport(owner, 'report', false, client);
assert.equal(query.where.reporterId, 'owner');
assert.deepEqual(query.include.progress.select, { id: true, stage: true, description: true, createdAt: true, attachments: { where: { state: 'ATTACHED', revokedAt: null }, select: { id: true, filename: true, contentType: true, size: true } } });
assert.equal(result.progress[0].actorDisplay, 'Government reviewer');
assert.equal(result.progress[0].actorId, undefined);
assert.equal(result.progress[0].actor, undefined);
assert.equal(result.progress[0].description, 'Checking the observation.');
assert.deepEqual(result.progress[0].attachments, [{ id: 'evidence', filename: 'inspection.jpg', contentType: 'image/jpeg', size: 1024 }]);
await assert.rejects(getReport({ id: 'other', role: 'USER' }, 'report', false, client), { code: 'NOT_FOUND' });
await assert.rejects(getReport(owner, 'report', true, client), { code: 'FORBIDDEN' });
const { privateDownloadItem } = await import('./src/modules/uploads/uploads.service.ts');
const evidence = { objectKey: 'evidence/admin/progress', contentType: 'image/jpeg', uploaderId: 'admin', reportProgressId: 'progress', reportOwnerId: owner.id };
let attachmentQuery;
const downloadClient = current => ({ $transaction: async callback => callback({
  $queryRaw: async () => [],
  msUser: { findUnique: async () => current },
  trAttachment: { findFirst: async query => {
    attachmentQuery = query;
    if (current.role === 'ADMIN') return evidence;
    const progressOwner = query.where.OR?.[1]?.reportProgress?.report?.reporterId;
    const ownUnattached = query.where.OR?.[0]?.uploaderId === evidence.uploaderId && evidence.reportProgressId === null;
    return progressOwner === evidence.reportOwnerId || ownUnattached ? evidence : null;
  } },
}) });
assert.equal((await privateDownloadItem({ id: owner.id }, 'evidence', downloadClient({ id: owner.id, role: 'USER', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false })))?.objectKey, evidence.objectKey);
assert.equal(attachmentQuery.where.OR[1].reportProgress.report.reporterId, owner.id);
assert.equal(await privateDownloadItem({ id: 'other' }, 'evidence', downloadClient({ id: 'other', role: 'USER', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false })), null);
assert.equal((await privateDownloadItem({ id: 'admin' }, 'evidence', downloadClient({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false })))?.objectKey, evidence.objectKey);
assert.equal(attachmentQuery.where.OR, undefined);
const progressInput = { description: 'Inspection evidence added.', attachmentIds: ['ready-photo'], idempotencyKey: '00000000-0000-4000-8000-000000000010' };
let progressState = { entries: [], attached: [], audits: [], notifications: [] }, progressFailure = false, progressAuditFailure = false;
const progressTx = {
  $queryRaw: async () => [], msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
  trReport: { findUniqueOrThrow: async () => ({ id: 'report', reviewStatus: 'UNDER_REVIEW', reporterId: owner.id }) },
  trReportProgress: {
    findUnique: async ({ where }) => progressState.entries.find(item => item.actorId === where.actorId_idempotencyKey.actorId && item.idempotencyKey === where.actorId_idempotencyKey.idempotencyKey) ?? null,
    create: async ({ data }) => { const item = { id: 'manual-progress', createdAt: new Date('2026-09-02T00:00:00Z'), attachments: [], ...data }; progressState.entries.push(item); return item; },
    findUniqueOrThrow: async ({ where }) => ({ ...progressState.entries.find(item => item.id === where.id), attachments: progressState.attached.map(id => ({ id, filename: 'inspection.jpg', contentType: 'image/jpeg', size: 1024 })) }),
  },
  trAttachment: { updateMany: async ({ where, data }) => { progressState.attached.push(...where.id.in); return { count: data.reportProgressId && !progressFailure ? where.id.in.length : 0 }; } },
  trNotification: { createMany: async ({ data }) => { progressState.notifications.push(...data); return { count: data.length }; } },
  trAuditLog: { create: async ({ data }) => { if (progressAuditFailure) throw new Error('Progress audit failed'); progressState.audits.push(data); } },
};
const progressClient = { $transaction: async callback => { const before = structuredClone(progressState); try { return await callback(progressTx); } catch (error) { progressState = before; throw error; } } };
progressAuditFailure = true;
await assert.rejects(addReportProgress({ id: 'admin' }, 'report', progressInput, progressClient), /Progress audit failed/);
assert.equal(progressState.entries.length, 0); assert.equal(progressState.attached.length, 0); assert.equal(progressState.notifications.length, 0);
progressAuditFailure = false;
const manualProgress = await addReportProgress({ id: 'admin' }, 'report', progressInput, progressClient);
assert.equal(manualProgress.description, progressInput.description); assert.equal(manualProgress.attachments[0].id, 'ready-photo');
const retryProgress = await addReportProgress({ id: 'admin' }, 'report', progressInput, progressClient);
assert.equal(retryProgress.id, manualProgress.id); assert.equal(progressState.entries.length, 1); assert.equal(progressState.notifications.length, 1); assert.equal(progressState.audits.length, 1);
await assert.rejects(addReportProgress({ id: 'admin' }, 'report', { ...progressInput, description: 'Changed retry content.' }, progressClient), { code: 'IDEMPOTENCY_CONFLICT' });
const { reviewReport, updateCase, verifyCase } = await import('./src/modules/admin/admin.service.ts');
const admin = { id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false };
let user = { ...admin }, failProgress = false;
let report = { id: 'report', number: 'R-1', caseId: 'case', reviewStatus: 'NEW' };
let c = { id: 'case', version: 1, verificationStatus: 'UNVERIFIED', handlingStatus: 'OPEN', latitude: null, longitude: null };
let progress = [], audits = [], verifications = [], notifications = [];
let field = { id: 'field', caseId: 'case', findings: 'SMOKE_ONLY', latitude: null, longitude: null };
const tx = {
  $queryRaw: async () => [],
  msUser: { findUnique: async () => user },
  trReport: { findUniqueOrThrow: async () => ({ ...report, reporterId: owner.id }), update: async ({ data }) => { for (const [key, value] of Object.entries(data)) if (value !== undefined) report[key] = value; return { ...report, reporterId: owner.id }; }, findMany: async ({ where }) => report.caseId === where.caseId ? [{ id: report.id, reporterId: owner.id }] : [] },
  trCase: { findUniqueOrThrow: async () => ({ ...c }), update: async ({ data }) => { for (const [key, value] of Object.entries(data)) if (value !== undefined) c[key] = value && typeof value === 'object' && 'increment' in value ? (c[key] ?? 0) + value.increment : value; return { ...c }; } },
  trReportProgress: { create: async ({ data }) => { if (failProgress) throw new Error('Progress write failed'); progress.push(data); return data; }, createMany: async ({ data }) => { if (failProgress) throw new Error('Progress write failed'); progress.push(...data); } },
  trNotification: { createMany: async ({ data }) => { notifications.push(...data); return { count: data.length }; } },
  trAuditLog: { create: async ({ data }) => audits.push(data) },
  trAssignment: { count: async () => 0 },
  trFieldUpdate: { findFirst: async () => field },
  trVerification: { create: async ({ data }) => verifications.push(data) },
};
const transactional = { $transaction: async callback => { const old = structuredClone({ report, c, progress, audits, verifications, notifications }); try { return await callback(tx); } catch (error) { ({ report, c, progress, audits, verifications, notifications } = old); throw error; } } };
const reviewInput = { reviewStatus: 'UNDER_REVIEW', reason: 'Private review basis', reporterMessage: 'Checking the submitted observation.' };
user.role = 'USER';
await assert.rejects(reviewReport(admin, report.id, reviewInput, transactional), { code: 'FORBIDDEN' });
user.role = 'ADMIN';
failProgress = true;
await assert.rejects(reviewReport(admin, report.id, reviewInput, transactional), /Progress write failed/);
assert.equal(report.reviewStatus, 'NEW'); assert.equal(progress.length, 0);
failProgress = false;
await reviewReport(admin, report.id, reviewInput, transactional);
assert.equal(progress[0].stage, 'UNDER_REVIEW'); assert.equal(progress[0].description, reviewInput.reporterMessage);
assert.equal(c.verificationStatus, 'UNVERIFIED');
await assert.rejects(reviewReport(admin, report.id, reviewInput, transactional), { code: 'INVALID_TRANSITION' });
await reviewReport(admin, report.id, { caseId: 'case', reason: 'Opened case from citizen report R-1' }, transactional);
assert.equal(report.reviewStatus, 'UNDER_REVIEW'); assert.equal(progress.length, 1);
const decision = { version: c.version, outcome: 'CONFIRMED_FIRE', fieldUpdateId: 'field', reason: 'Private patrol notes', authorityReference: 'Restricted mandate', reporterMessage: 'Field inspection confirmed visible fire.', perimeter: { type: 'Polygon', coordinates: [[[110, -2], [110.01, -2], [110.01, -2.01], [110, -2]]] }, perimeterObservedAt: '2026-09-01T00:00:00Z', perimeterSource: 'Patrol boundary observation' };
await assert.rejects(verifyCase(admin, c.id, decision, transactional), { code: 'INSUFFICIENT_EVIDENCE' });
field.findings = 'VISIBLE_FIRE'; user.emailVerified = false;
await assert.rejects(verifyCase(admin, c.id, decision, transactional), { code: 'FORBIDDEN' });
user.emailVerified = true;
await verifyCase(admin, c.id, decision, transactional);
assert.equal(progress.at(-1).stage, 'CONFIRMED_FIRE'); assert.equal(progress.at(-1).description, decision.reporterMessage);
assert.equal(verifications[0].authorityReference, 'Restricted mandate');
const handling = { version: c.version, handlingStatus: 'RESPONDING', reason: 'Private dispatch notes', reporterMessage: 'Response operations have started.' };
failProgress = true;
await assert.rejects(updateCase(admin, c.id, handling, transactional), /Progress write failed/);
assert.equal(c.handlingStatus, 'OPEN');
failProgress = false;
await updateCase(admin, c.id, handling, transactional);
assert.equal(progress.at(-1).stage, 'RESPONDING'); assert.equal(progress.at(-1).description, handling.reporterMessage);
const count = progress.length;
await updateCase(admin, c.id, { ...handling, version: c.version }, transactional);
assert.equal(progress.length, count);
assert.equal(JSON.stringify(progress).includes('Restricted mandate'), false);
assert.equal(JSON.stringify(progress).includes('Private'), false);
assert.equal(progress.every(item => item.reportId === report.id && item.actorId === admin.id), true);
const verificationBeforeDecline = c.verificationStatus;
const decisionsBeforeDecline = verifications.length;
await reviewReport(admin, report.id, { reviewStatus: 'DECLINED', reason: 'Duplicate observation', reporterMessage: 'Duplicate report declined; no new fire finding.' }, transactional);
assert.equal(report.reviewStatus, 'DECLINED');
assert.equal(c.verificationStatus, verificationBeforeDecline);
assert.equal(verifications.length, decisionsBeforeDecline);
assert.equal(progress.at(-1).stage, 'DECLINED');
console.log('Report progress owner/privacy projection, actual review/verification/handling transactions, evidence and capability gates, no-op suppression and rollback passed.');
