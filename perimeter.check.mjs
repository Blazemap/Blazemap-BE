import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
const { casePatchSchema, publicationSchema } = await import('./src/types/index.ts');
const polygon = { type: 'Polygon', coordinates: [[[110, 0], [110.01, 0], [110.01, 0.01], [110, 0.01], [110, 0]]] };
const patch = { version: 1, perimeter: polygon, perimeterObservedAt: '2026-09-01T00:00:00Z', perimeterSource: 'Field survey', reason: 'Survey checked', authorityReference: 'Authority 123' };
assert.equal(casePatchSchema.safeParse(patch).success, true, 'The existing case PATCH must accept the perimeter variant');
const { polygonSchema, areaHectares, geometryDistanceMeters } = await import('./src/utils/geometry.ts');
assert.ok(areaHectares(polygon) > 123 && areaHectares(polygon) < 124);
assert.equal(geometryDistanceMeters([110.005, 0.005], polygon), 0);
for (const coordinates of [
  [], [[]],
  [[[0, 0], [1, 1], [2, 2], [0, 0]]],
  [[[179, 0], [-179, 0], [-179, 1], [179, 0]]],
  [[[0, 0], [2, 0], [1, 0], [2, 1], [0, 0]]],
  [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]],
  [[[0, 0], [1, 0], [2, 0], [0, 0]]],
  [[[0, 0], [1, 0], [1, 1], [1, 0], [0, 0]]],
  [[[0, 0], [1, 0], [1, 1], [0, 1]]],
  [[[181, 0], [1, 0], [1, 1], [181, 0]]],
  [[[0, 91], [1, 0], [1, 1], [0, 91]]],
  [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]],
]) assert.equal(polygonSchema.safeParse({ type: 'Polygon', coordinates }).success, false);
const concave = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]]] };
assert.equal(geometryDistanceMeters([0.5, 1.5], concave), 0);
assert.ok(geometryDistanceMeters([1.5, 1.5], concave) > 50000);
assert.equal(geometryDistanceMeters([1, 1.5], concave), 0);
const hole = { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] };
assert.equal(polygonSchema.safeParse(hole).success, true);
assert.ok(geometryDistanceMeters([1.5, 1.5], hole) > 50000);
const many = Array.from({ length: 1000 }, (_, i) => [110 + Math.cos(i / 1000 * Math.PI * 2), Math.sin(i / 1000 * Math.PI * 2)]);
assert.equal(polygonSchema.safeParse({ type: 'Polygon', coordinates: [[...many, many[0]]] }).success, false);
assert.equal(casePatchSchema.safeParse({ ...patch, priority: 'HIGH' }).success, false);
const publication = { title: 'Fire update', summary: 'Verified survey', body: 'Verified survey update', type: 'UPDATE', sources: [], caseId: 'case', publicLocationMode: 'APPROVED_INCIDENT_PERIMETER', privacyReview: 'Boundary approved for public release' };
assert.equal(publicationSchema.safeParse(publication).success, true);
assert.equal(publicationSchema.safeParse({ ...publication, privacyReview: null }).success, false);
const { updateCase, addFieldUpdate, verifyCase } = await import('./src/modules/admin/admin.service.ts');
const { publishInformation } = await import('./src/modules/admin/information.service.ts');
const { publicMap } = await import('./src/modules/public/public.service.ts');
const { publicPerimeter } = await import('./src/utils/geometry.ts');
const actor = { id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: true, canPublishInformation: true };
let user = { ...actor }, auditFailure = false;
let c = { id: 'case', number: 'C-1', title: 'Private title', verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'MONITORING', latitude: 1, longitude: 110, version: 1, contextRevision: 1, perimeterRevision: 0, perimeter: null, perimeterObservedAt: null, perimeterSource: null, latestAnalysisId: 'analysis' };
let publicationRow = { ...publication, id: 'publication', status: 'DRAFT', updatedAt: new Date('2026-09-01T00:00:00Z'), validUntil: null, regions: [], sources: [{ title: 'Authority', url: 'https://example.invalid' }] };
let audits = [], locks = [], fields = [], verifications = [];
const tx = {
  $queryRaw: async (strings, id) => { locks.push([strings.join('?'), id]); return [{ id }]; },
  msUser: { findUnique: async () => user },
  trAssignment: { count: async () => 0 },
  trCase: {
    findUniqueOrThrow: async () => structuredClone(c),
    update: async ({ where, data }) => {
      assert.ok(locks.some(([sql, id]) => sql.includes('TrCase') && id === c.id));
      if (where.version !== undefined) assert.equal(where.version, c.version);
      for (const [key, value] of Object.entries(data)) if (value !== undefined) c[key] = value && typeof value === 'object' && 'increment' in value ? (c[key] ?? 0) + value.increment : structuredClone(value);
      return structuredClone(c);
    },
  },
  trAuditLog: { create: async ({ data }) => { if (auditFailure) throw new Error('Audit failed'); audits.push(structuredClone(data)); } },
  trFieldUpdate: { create: async ({ data }) => { const item = { id: 'field', ...data }; fields.push(item); return item; }, findFirst: async () => fields.at(-1) },
  trVerification: { create: async ({ data }) => verifications.push(data) },
  trReport: { findMany: async () => [] },
  trReportProgress: { createMany: async () => ({ count: 0 }) },
  trPublicInformation: {
    findUniqueOrThrow: async () => structuredClone(publicationRow),
    update: async ({ data }) => { Object.assign(publicationRow, structuredClone(data)); return structuredClone(publicationRow); },
    count: async () => 0,
  },
};
const client = { $transaction: async callback => {
  const previous = structuredClone({ c, publicationRow, audits, fields, verifications });
  try { return await callback(tx); } catch (error) { ({ c, publicationRow, audits, fields, verifications } = previous); throw error; }
} };
for (const denied of [{ role: 'USER' }, { active: false }, { emailVerified: false }]) {
  user = { ...actor, ...denied };
  await assert.rejects(updateCase(actor, c.id, patch, client), error => ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code));
  assert.equal(c.version, 1); assert.equal(audits.length, 0);
}
user = { ...actor, canConfirmIncidents: false, canPublishInformation: false };
for (const status of ['UNVERIFIED', 'NOT_FIRE']) {
  c.verificationStatus = status;
  await assert.rejects(updateCase(actor, c.id, patch, client), { code: 'INVALID_TRANSITION' });
}
c.verificationStatus = 'CONFIRMED_FIRE';
await assert.rejects(updateCase(actor, c.id, { ...patch, version: 2 }, client), { code: 'VERSION_CONFLICT' });
auditFailure = true;
await assert.rejects(updateCase(actor, c.id, patch, client), /Audit failed/);
assert.equal(c.perimeter, null); assert.equal(c.version, 1);
auditFailure = false;
const saved = await updateCase(actor, c.id, patch, client);
assert.equal(saved.version, 2); assert.equal(saved.contextRevision, 2); assert.equal(saved.perimeterRevision, 1); assert.equal(saved.latestAnalysisId, null);
assert.equal(saved.latitude, 1); assert.equal(saved.longitude, 110);
assert.equal(audits[0].action, 'CASE_PERIMETER_UPDATED');
assert.equal(audits[0].details.authorityReference, patch.authorityReference);
assert.deepEqual(audits[0].details.after.perimeter, polygon);
assert.equal(publicationRow.status, 'DRAFT'); assert.equal(publicationRow.publicCaseSnapshot, undefined);
const publishInput = { expectedUpdatedAt: publicationRow.updatedAt.toISOString(), authorityReference: 'Publish authority', expectedCaseVersion: c.version };
await assert.rejects(publishInformation(actor, publicationRow.id, { ...publishInput, expectedUpdatedAt: '2026-09-02T00:00:00Z' }, client), { code: 'PUBLICATION_CONFLICT' });
for (const change of [{ privacyReview: null }, { caseId: null }]) {
  const old = structuredClone(publicationRow); Object.assign(publicationRow, change);
  await assert.rejects(publishInformation(actor, publicationRow.id, publishInput, client), { code: 'PRIVACY_REVIEW_REQUIRED' }); publicationRow = old;
}
user.role = 'USER';
await assert.rejects(publishInformation(actor, publicationRow.id, publishInput, client), { code: 'FORBIDDEN' });
user.role = 'ADMIN';
c.verificationStatus = 'UNVERIFIED';
await assert.rejects(publishInformation(actor, publicationRow.id, publishInput, client), { code: 'INVALID_PERIMETER' });
c.verificationStatus = 'CONFIRMED_FIRE';
auditFailure = true;
await assert.rejects(publishInformation(actor, publicationRow.id, publishInput, client), /Audit failed/);
assert.equal(publicationRow.status, 'DRAFT'); assert.equal(publicationRow.publicCaseSnapshot, undefined);
auditFailure = false;
await publishInformation(actor, publicationRow.id, publishInput, client);
const frozen = structuredClone(publicationRow.publicCaseSnapshot);
assert.equal(frozen.publicPerimeter.revision, 1);
assert.deepEqual(frozen.publicPerimeter.geometry, polygon);
await updateCase(actor, c.id, { ...patch, version: c.version, perimeter: concave }, client);
assert.equal(c.perimeterRevision, 2);
assert.deepEqual(publicationRow.publicCaseSnapshot, frozen);
assert.deepEqual(publicPerimeter(publicationRow).publicPerimeter, frozen.publicPerimeter);
for (const mode of ['NONE', 'REGION_ONLY', 'APPROVED_INCIDENT_POINT']) assert.deepEqual(publicPerimeter({ ...publicationRow, publicLocationMode: mode }), {});
for (const change of [{ revision: 0 }, { areaHectares: -1 }, { areaHectares: 1 }, { geometry: { type: 'Point', coordinates: [110, 0] } }, { observedAt: 'invalid' }]) assert.deepEqual(publicPerimeter({ ...publicationRow, publicCaseSnapshot: { ...frozen, publicPerimeter: { ...frozen.publicPerimeter, ...change } } }), {});
const mapClient = { trIntegrationRun: { findFirst: async () => null }, trHotspot: { findMany: async () => [] }, trPublicInformation: { findMany: async () => [publicationRow] }, msMapFeature: { findMany: async () => [] }, trCase: { findUnique: () => assert.fail('Public reads must never fetch private case') } };
const projection = (await publicMap({}, mapClient, false)).cases[0];
assert.deepEqual(projection.publicPerimeter, frozen.publicPerimeter);
assert.equal(projection.latitude, null); assert.equal(projection.longitude, null);
assert.equal(projection.perimeter, undefined);
publicationRow.publicLocationMode = 'APPROVED_INCIDENT_POINT'; publicationRow.publicLatitude = 2; publicationRow.publicLongitude = 111;
const pointProjection = (await publicMap({}, mapClient, false)).cases[0];
assert.equal(pointProjection.latitude, 2); assert.equal(pointProjection.longitude, 111); assert.equal(pointProjection.publicPerimeter, undefined);
assert.equal(typeof verifyCase, 'function');
await addFieldUpdate(actor, c.id, { findings: 'VISIBLE_FIRE', description: 'Visible fire confirmed by patrol', source: 'Field patrol', observedAt: patch.perimeterObservedAt, latitude: 0.5, longitude: 110.5 }, client);
assert.equal(fields.length, 1);
assert.deepEqual(fields[0].latitude, 0.5);
await verifyCase(actor, c.id, { version: c.version, outcome: 'CONFIRMED_FIRE', fieldUpdateId: fields[0].id, reason: 'Patrol confirms visible fire', reporterMessage: 'Field inspection confirmed visible fire.', authorityReference: 'Authority 123', perimeter: concave, perimeterObservedAt: patch.perimeterObservedAt, perimeterSource: patch.perimeterSource }, client);
assert.equal(c.latitude, 0.5); assert.equal(c.longitude, 110.5); assert.equal(verifications.length, 1);
assert.deepEqual(publicationRow.publicCaseSnapshot, frozen);
const beforePriority = c.perimeterRevision;
user.canConfirmIncidents = false;
await updateCase(actor, c.id, { version: c.version, priority: 'HIGH', reason: 'Existing priority update' }, client);
assert.equal(c.priority, 'HIGH'); assert.equal(c.perimeterRevision, beforePriority);
user.canConfirmIncidents = true;
fields[0].findings = 'SMOKE_ONLY';
await assert.rejects(verifyCase(actor, c.id, { version: c.version, outcome: 'CONFIRMED_FIRE', fieldUpdateId: fields[0].id, reason: 'Cannot confirm from smoke', reporterMessage: 'Inspection did not confirm visible fire.', authorityReference: 'Authority 123', perimeter: concave, perimeterObservedAt: patch.perimeterObservedAt, perimeterSource: patch.perimeterSource }, client), { code: 'INSUFFICIENT_EVIDENCE' });
assert.equal(verifications.length, 1);
console.log('Perimeter topology/area, authorization, version locking, audit rollback, publication review, frozen snapshot isolation and unchanged point/field-update flows passed.');
