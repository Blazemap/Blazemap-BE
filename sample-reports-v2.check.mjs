import assert from 'node:assert/strict';
process.env.DATABASE_URL = '';
const { sampleReportV2Plan, sampleReportV2Flags, sampleReportV2Notice, trustedPhotoUrl, photoSources } = await import('./src/seed-sample-reports-v2.ts');
const { triageReports } = await import('./src/modules/reports/triage.ts');
const { polygonSchema, areaHectares, publicPerimeter } = await import('./src/utils/geometry.ts');
const now = new Date('2026-09-19T06:00:00Z');
const plan = sampleReportV2Plan(now);
assert.deepEqual(plan, sampleReportV2Plan(now));
assert.equal(plan.reports.length, 10);
assert.equal(new Set(plan.reports.map(r => r.id)).size, 10);
assert.equal(new Set(plan.reports.map(r => r.attachmentId)).size, 10);
assert.equal(new Set(photoSources.map(p => p.pageId)).size, 10);
assert.equal(new Set(plan.reports.map(r => r.email)).size, 6);
assert.deepEqual(Object.fromEntries(['NEW', 'UNDER_REVIEW', 'REVIEWED', 'DECLINED'].map(status => [status, plan.reports.filter(r => r.reviewStatus === status).length])), { NEW: 3, UNDER_REVIEW: 3, REVIEWED: 3, DECLINED: 1 });
assert.equal(plan.reports.reduce((sum, r) => sum + r.progress.length, 0), 17);
assert.equal(sampleReportV2Flags([]), false);
assert.equal(sampleReportV2Flags(['--apply', '--replace-sample-reports']), true);
for (const args of [['--apply'], ['--replace-sample-reports'], ['--unknown'], ['unexpected']]) assert.throws(() => sampleReportV2Flags(args));
const noEvidence = new Proxy({}, { get() { throw new Error('Synthetic reports must never query real evidence'); } });
for (const report of plan.reports) {
  assert.ok(report.payload.description.endsWith(sampleReportV2Notice));
  assert.doesNotMatch(report.payload.description + report.payload.locationDescription, /\b(?:TEST|DEMO)\b/i);
  assert.ok(report.payload.observedAt < now.toISOString());
  let previous = report.createdAt;
  for (const progress of report.progress) {
    assert.ok(progress.createdAt > previous && progress.createdAt < now);
    assert.ok(progress.description.endsWith(sampleReportV2Notice));
    previous = progress.createdAt;
  }
  const candidate = { ...report.payload, id: report.id, number: report.number, observedAt: new Date(report.payload.observedAt), description: 'Smoke beside a canal', locationDescription: 'Canal' };
  const triage = (await triageReports([candidate], noEvidence, { TRIAGE_HOTSPOT_RADIUS_METERS: '1000', TRIAGE_HOTSPOT_WINDOW_HOURS: '24', TRIAGE_SETTLEMENT_RADIUS_METERS: '1000' }, now, true)).get(candidate.id);
  assert.equal(triage.level, 'UNKNOWN');
  assert.ok(triage.reasonCodes.includes('SAMPLE_EXCLUDED'));
  assert.equal(triage.satelliteMatch, null);
  assert.equal(triage.settlementMatch, null);
}
assert.equal(plan.cases.length, 2);
for (const item of plan.cases) {
  assert.ok(polygonSchema.safeParse(item.perimeter).success);
  const ring = item.perimeter.coordinates[0];
  assert.ok(ring.length > 5);
  const signs = ring.slice(0, -1).map((a, i, points) => { const b = points[(i + 1) % points.length], c = points[(i + 2) % points.length]; return Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])); });
  assert.ok(signs.includes(1) && signs.includes(-1));
  assert.match(item.title, /Exercise/);
  assert.ok(item.publication.summary.includes(sampleReportV2Notice));
  const perimeter = { geometry: item.perimeter, observedAt: item.observedAt.toISOString(), source: 'Training fixture', revision: 1, areaHectares: areaHectares(item.perimeter) };
  const projection = { publicLocationMode: 'APPROVED_INCIDENT_PERIMETER', publicCaseSnapshot: { verificationStatus: 'CONFIRMED_FIRE', publicPerimeter: perimeter } };
  assert.deepEqual(publicPerimeter(projection), { publicPerimeter: perimeter });
  assert.deepEqual(publicPerimeter({ ...projection, publicCaseSnapshot: { ...projection.publicCaseSnapshot, publicPerimeter: { ...perimeter, privateIdentity: 'hidden' } } }), {});
  assert.deepEqual(publicPerimeter({ ...projection, publicCaseSnapshot: { ...projection.publicCaseSnapshot, publicPerimeter: { ...perimeter, areaHectares: 1 } } }), {});
}
assert.equal(plan.cases.filter(c => c.handlingStatus === 'CLOSED' && c.publication.outcome === 'CONFIRMED').length, 1);
for (const url of ['http://upload.wikimedia.org/a', 'https://evil.example/a', 'https://upload.wikimedia.org.evil.example/a', 'https://user:password@upload.wikimedia.org/a']) assert.throws(() => trustedPhotoUrl(url));
assert.equal(trustedPhotoUrl('https://upload.wikimedia.org/a').hostname, 'upload.wikimedia.org');
console.log('V2 plan determinism, flags, ten distinct image sources, 17 chronological progress entries, explicit disclosure, concave polygons, strict public projection and key-based triage exclusion passed.');
