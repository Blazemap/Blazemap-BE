import assert from 'node:assert/strict';
process.env.BETTER_AUTH_URL = 'https://blazemap.test';
const { listInformation, publishInformation, publishOutcome, getInformation, publicationDto } = await import('./src/modules/admin/information.service.ts');
const { outcomePublicationSchema, publicationSchema } = await import('./src/types/index.ts');

let query;
const reader = { trPublicInformation: { findMany: async args => { query = args; return []; }, count: async () => 0 }, $transaction: async calls => Promise.all(calls) };
await listInformation({ news: 'true' }, false, reader);
assert.equal(query.where.status, 'PUBLISHED');
assert.deepEqual(query.where.OR[0], { outcome: 'DECLINED' });
assert.deepEqual(query.where.OR[1].caseId, { not: null });
assert.deepEqual(query.where.OR[1].AND[0].publicCaseSnapshot, { path: ['verificationStatus'], equals: 'CONFIRMED_FIRE' });
assert.deepEqual(query.where.OR[1].AND[1].publicCaseSnapshot, { path: ['handlingStatus'], equals: 'CLOSED' });
assert.deepEqual(query.where.privacyReview, { not: null });
assert.equal(query.select.report, undefined);
assert.equal(query.select.case, undefined);
await listInformation({ news: 'true', page: '2', pageSize: '10' }, false, reader);
assert.equal(query.skip, 10);
assert.equal(query.take, 10);
await listInformation({ feed: 'true', pageSize: '10', from: '2026-09-01T00:00:00Z' }, false, reader);
assert.deepEqual(query.where.caseId, { not: null });
assert.equal(query.where.publishedAt.gte.toISOString(), '2026-09-01T00:00:00.000Z');
const redacted = publicationDto({ regions: [], validUntil: null, publicLocationMode: 'NONE', publicLatitude: 1, publicLongitude: 2, publicCaseSnapshot: { private: 'not public' } });
assert.equal(redacted.latitude, null);
assert.equal(redacted.publicLatitude, null);
assert.equal(redacted.publicCaseSnapshot, undefined);
let detailQuery;
await assert.rejects(getInformation('hidden', false, { trPublicInformation: { findFirst: async args => { detailQuery = args; return null; } } }), { code: 'NOT_FOUND' });
assert.equal(detailQuery.where.slug, 'hidden');
assert.deepEqual(detailQuery.where.status.in, ['PUBLISHED', 'SUPERSEDED', 'WITHDRAWN']);
assert.ok(detailQuery.where.publishedAt.lte instanceof Date);
assert.equal(detailQuery.select.report, undefined);
assert.deepEqual(detailQuery.select.attachments.where, { approvedAt: { not: null }, revokedAt: null });
const draft = { title: 'Reviewed outcome', summary: 'Approved public summary', body: 'Approved public description', type: 'UPDATE', sources: [{ title: 'Source', url: 'https://example.org/evidence' }], outcome: 'DECLINED', reportId: 'report', privacyReview: 'Reviewed without identifying details' };
assert.equal(publicationSchema.safeParse(draft).success, true);
assert.equal(publicationSchema.safeParse({ ...draft, privacyReview: null }).success, false);
const actor = { id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canPublishInformation: false };
let user = { ...actor };
let state = { report: { reviewStatus: 'DECLINED' }, item: { ...draft, id: 'draft', status: 'DRAFT', updatedAt: new Date('2026-09-01'), regions: [], publicLocationMode: 'NONE', caseId: null }, writes: [] };
const tx = { $queryRaw: async () => [], msUser: { findUnique: async () => user }, trReport: { findUniqueOrThrow: async () => state.report }, trPublicInformation: { findUniqueOrThrow: async () => state.item, update: async ({ data }) => { state.writes.push(data); return { ...state.item, ...data, regions: [], validUntil: null }; } }, trAuditLog: { create: async () => {} } };
const client = { $transaction: async fn => { const before = structuredClone(state); try { return await fn(tx); } catch (error) { state = before; throw error; } } };
const approval = { authorityReference: 'Real publication mandate', expectedUpdatedAt: state.item.updatedAt.toISOString() };
for (const change of [{ role: 'USER', canPublishInformation: true }, { emailVerified: false }, { active: false }]) {
  user = { ...actor, ...change };
  await assert.rejects(publishInformation(actor, 'draft', approval, client), error => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code));
  assert.equal(state.writes.length, 0);
}
user = { ...actor };
state.report.reviewStatus = 'REVIEWED';
await assert.rejects(publishInformation(actor, 'draft', approval, client), { code: 'OUTCOME_CHANGED' });
state.report.reviewStatus = 'DECLINED';
await publishInformation(actor, 'draft', approval, client);
assert.equal(state.writes[0].status, 'PUBLISHED');
assert.equal(state.writes[0].publicCaseSnapshot, undefined);
state.item = { ...state.item, outcome: 'CONFIRMED', caseId: 'case', reportId: null };
tx.trCase = { findUniqueOrThrow: async () => ({ id: 'case', version: 4, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'CLOSED' }) };
await assert.rejects(publishInformation(actor, 'draft', { ...approval, expectedCaseVersion: 3 }, client), { code: 'VERSION_CONFLICT' });
const writesBefore = state.writes.length;
await publishInformation(actor, 'draft', { ...approval, expectedCaseVersion: 4 }, client);
assert.equal(state.writes.length, writesBefore + 1);
assert.equal(state.writes.at(-1).publicCaseSnapshot.verificationStatus, 'CONFIRMED_FIRE');
const confirmedInput = { caseId: 'case', expectedCaseVersion: 4, message: 'Reviewed public update.', publish: true, privacyApproved: true, idempotencyKey: '00000000-0000-4000-8000-000000000001' };
const declinedInput = { reportId: 'report', message: 'This report was declined after review.', publish: true, privacyApproved: true, idempotencyKey: '00000000-0000-4000-8000-000000000002' };
assert.equal(outcomePublicationSchema.safeParse(confirmedInput).success, true);
assert.equal(outcomePublicationSchema.safeParse(declinedInput).success, true);
assert.equal(outcomePublicationSchema.safeParse({ ...confirmedInput, reportId: 'report' }).success, false);
let outcomeState = { publications: [], audits: [], report: { id: 'report', number: 'R-1', reviewStatus: 'DECLINED' }, case: { id: 'case', number: 'C-1', version: 4, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'CLOSED', perimeter: { type: 'Polygon', coordinates: [[[110, -2], [110.01, -2], [110.01, -2.01], [110, -2]]] }, perimeterObservedAt: new Date('2026-09-01T00:00:00Z'), perimeterRevision: 1 } };
const outcomeTx = {
  $queryRaw: async () => [], msUser: { findUnique: async () => user },
  trReport: { findUniqueOrThrow: async () => structuredClone(outcomeState.report) }, trCase: { findUniqueOrThrow: async () => structuredClone(outcomeState.case) },
  trPublicInformation: {
    findUnique: async ({ where }) => outcomeState.publications.find(item => item.slug === where.slug) ?? null,
    create: async ({ data }) => { const item = { id: `publication-${outcomeState.publications.length + 1}`, ...structuredClone(data), updatedAt: new Date(), validUntil: null, regions: [], attachments: [], replacements: [], supersedes: null, withdrawalReason: null, supersedesId: null, authorityReference: null, publicLatitude: null, publicLongitude: null }; outcomeState.publications.push(item); return structuredClone(item); },
  },
  trAuditLog: { create: async ({ data }) => { outcomeState.audits.push(structuredClone(data)); return { id: 'audit' }; } },
};
const outcomeClient = { $transaction: async callback => { const before = structuredClone(outcomeState); try { return await callback(outcomeTx); } catch (error) { outcomeState = before; throw error; } } };
await assert.rejects(publishOutcome(actor, { ...confirmedInput, expectedCaseVersion: 3 }, outcomeClient), { code: 'VERSION_CONFLICT' });
assert.equal(outcomeState.publications.length, 0);
const confirmedNews = await publishOutcome(actor, confirmedInput, outcomeClient);
assert.equal(confirmedNews.outcome, 'CONFIRMED');
assert.equal(confirmedNews.publicLocationMode, 'APPROVED_INCIDENT_PERIMETER');
assert.equal(confirmedNews.publicPerimeter.revision, 1);
assert.equal(JSON.stringify(confirmedNews).includes('private-admin'), false);
assert.equal((await publishOutcome(actor, confirmedInput, outcomeClient)).id, confirmedNews.id);
assert.equal(outcomeState.publications.length, 1);
const declinedNews = await publishOutcome(actor, declinedInput, outcomeClient);
assert.equal(declinedNews.outcome, 'DECLINED');
assert.equal(declinedNews.publicLocationMode, 'NONE');
assert.equal(declinedNews.latitude, null);
assert.equal(declinedNews.publicPerimeter, undefined);
outcomeState.report.reviewStatus = 'REVIEWED';
await assert.rejects(publishOutcome(actor, { ...declinedInput, idempotencyKey: '00000000-0000-4000-8000-000000000003' }, outcomeClient), { code: 'OUTCOME_CHANGED' });
assert.equal(outcomeState.publications.length, 2);
console.log('News publication filtering, concise explicit opt-in, idempotency, frozen perimeter, privacy, stale actor/version denial and decline without fire inference passed.');
