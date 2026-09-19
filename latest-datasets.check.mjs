import assert from 'node:assert/strict';
import { listNotifications, markNotificationRead, markAllNotificationsRead, createReportNotification } from './src/modules/notifications/notifications.service.ts';
import { listCitizenFeed } from './src/modules/reports/feed.service.ts';
import { listInformation } from './src/modules/admin/information.service.ts';
import { roleMap } from './src/modules/public/public.service.ts';

const owner = { id: 'owner', role: 'USER', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false };
let notificationQuery;
const notificationRows = [{ id: 'n-2', eventKey: 'progress:p-2', userId: owner.id, reportId: 'report', type: 'REPORT_STATUS', title: 'Report reviewed', message: 'Review completed.', createdAt: new Date('2026-09-19T02:00:00Z'), readAt: null }];
const notificationClient = {
  $transaction: async calls => Promise.all(calls),
  trNotification: {
    findFirst: async ({ where }) => notificationRows.find(item => item.id === where.id && item.userId === where.userId) ?? null,
    findMany: async query => { notificationQuery = query; return notificationRows; },
    count: async ({ where }) => where.userId === owner.id && where.readAt === null ? 1 : 0,
    updateMany: async ({ where, data }) => {
      const item = notificationRows.find(value => value.id === where.id && value.userId === where.userId);
      if (!item) return { count: 0 };
      if (!item.readAt) item.readAt = data.readAt;
      return { count: 1 };
    },
  },
};
const firstPage = await listNotifications(owner, {}, notificationClient);
assert.equal(notificationQuery.where.userId, owner.id);
assert.equal(notificationQuery.take, 11);
assert.equal(firstPage.data.length, 1);
assert.equal(firstPage.meta.pageSize, 10);
assert.equal(firstPage.meta.unreadCount, 1);
await assert.rejects(markNotificationRead({ ...owner, id: 'other' }, 'n-2', notificationClient), { code: 'NOT_FOUND' });
assert.equal(notificationRows[0].readAt, null);
await markNotificationRead(owner, 'n-2', notificationClient);
assert.ok(notificationRows[0].readAt instanceof Date);
notificationRows[0].readAt = null;
notificationClient.trNotification.updateMany = async ({ where, data }) => { assert.deepEqual(where, { userId: owner.id, readAt: null }); notificationRows[0].readAt = data.readAt; return { count: 1 }; };
assert.equal((await markAllNotificationsRead(owner, notificationClient)).updated, 1);

const created = [];
const tx = {
  trNotification: { createMany: async ({ data, skipDuplicates }) => { assert.equal(skipDuplicates, true); for (const item of data) if (!created.some(value => value.eventKey === item.eventKey)) created.push(item); return { count: 1 }; } },
  trReport: { findUniqueOrThrow: async () => ({ reporterId: owner.id }) },
};
await createReportNotification(tx, { eventKey: 'progress:p-1', reportId: 'report', type: 'REPORT_STATUS', stage: 'UNDER_REVIEW', message: 'Review started.' });
await createReportNotification(tx, { eventKey: 'progress:p-1', reportId: 'report', type: 'REPORT_STATUS', stage: 'UNDER_REVIEW', message: 'Review started.' });
assert.equal(created.length, 1);
assert.equal(JSON.stringify(created).includes('actor'), false);
assert.equal(JSON.stringify(created).includes('mandate'), false);

let feedQueries;
const feedClient = {
  $transaction: async calls => Promise.all(calls),
  trReport: {
    findMany: async query => { feedQueries = { ...feedQueries, reports: query }; return [{ id: 'own', number: 'R-1', description: 'My private report', observationTypes: ['SMOKE'], observedAt: new Date('2026-09-19T01:00:00Z'), createdAt: new Date('2026-09-19T01:00:00Z'), locationMode: 'INCIDENT_ESTIMATE', latitude: 1, longitude: 2, accuracyMeters: null, regionId: null, locationDescription: 'Private location', reviewStatus: 'NEW', case: null, region: null, attachments: [] }]; },
    count: async query => { feedQueries = { ...feedQueries, reportCount: query }; return 1; },
  },
  trPublicInformation: {
    findMany: async query => { feedQueries = { ...feedQueries, publications: query }; return [{ id: 'public', slug: 'active-fire', title: 'Active confirmed incident', summary: 'Public summary', body: 'Public body', type: 'UPDATE', outcome: 'CONFIRMED', status: 'PUBLISHED', sources: [], publishedAt: new Date('2026-09-19T02:00:00Z'), updatedAt: new Date('2026-09-19T02:00:00Z'), validUntil: null, authorityReference: null, withdrawalReason: null, supersedesId: null, publicLocationMode: 'APPROVED_INCIDENT_POINT', publicLatitude: 3, publicLongitude: 4, publicCaseSnapshot: { number: 'C-1', verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'RESPONDING' }, supersedes: null, replacements: [], attachments: [], regions: [] }]; },
    count: async query => { feedQueries = { ...feedQueries, publicationCount: query }; return 1; },
  },
};
const feed = await listCitizenFeed(owner, { page: '1', pageSize: '10' }, feedClient);
assert.equal(feedQueries.reports.where.reporterId, owner.id);
assert.equal(feedQueries.publications.where.status, 'PUBLISHED');
assert.deepEqual(feedQueries.publications.where.AND[1].publicCaseSnapshot, { path: ['verificationStatus'], equals: 'CONFIRMED_FIRE' });
assert.equal(JSON.stringify(feedQueries.publications.where).includes('handlingStatus'), false);
assert.ok(feedQueries.publications.where.NOT.some(value => value.report?.is?.reporterId === owner.id));
assert.ok(feedQueries.publications.where.NOT.some(value => value.case?.is?.reports?.some?.reporterId === owner.id));
assert.deepEqual(feed.data.map(item => item.kind), ['PUBLICATION', 'OWN_REPORT']);
assert.equal(feed.meta.pageSize, 10);
assert.equal(JSON.stringify(feed.data).includes('reporterId'), false);

let newsQuery;
const newsClient = { trPublicInformation: { findMany: async query => { newsQuery = query; return []; }, count: async () => 0 }, $transaction: async calls => Promise.all(calls) };
await listInformation({ news: 'true', pageSize: '10' }, false, newsClient);
assert.equal(newsQuery.where.status, 'PUBLISHED');
assert.deepEqual(newsQuery.where.OR[0], { outcome: 'DECLINED' });
assert.deepEqual(newsQuery.where.OR[1].caseId, { not: null });
assert.deepEqual(newsQuery.where.OR[1].AND[0].publicCaseSnapshot, { path: ['verificationStatus'], equals: 'CONFIRMED_FIRE' });
assert.deepEqual(newsQuery.where.OR[1].AND[1].publicCaseSnapshot, { path: ['handlingStatus'], equals: 'CLOSED' });

const now = new Date();
const polygon = { type: 'Polygon', coordinates: [[[110, -2], [110.1, -2], [110, -1.9], [110, -2]]] };
const reports = [
  { id: 'own-associated', reporterId: owner.id, number: 'R-own-associated', observationTypes: ['SMOKE'], observedAt: now, createdAt: now, locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 110, accuracyMeters: null, regionId: null, locationDescription: 'Owner associated private location', description: 'Owner associated report', reviewStatus: 'REVIEWED', caseId: 'case-1', case: { id: 'case-1', number: 'C-1', verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'RESPONDING' }, region: null, attachments: [] },
  { id: 'own-private', reporterId: owner.id, number: 'R-own-private', observationTypes: ['SMOKE'], observedAt: now, createdAt: now, locationMode: 'INCIDENT_ESTIMATE', latitude: -1, longitude: 111, accuracyMeters: null, regionId: null, locationDescription: 'Owner private location', description: 'Owner private report', reviewStatus: 'NEW', caseId: null, case: null, region: null, attachments: [] },
  { id: 'other-private', reporterId: 'other', number: 'R-other', observationTypes: ['FLAME'], observedAt: now, createdAt: now, locationMode: 'INCIDENT_ESTIMATE', latitude: -3, longitude: 112, accuracyMeters: null, regionId: null, locationDescription: 'Other private location', description: 'Other private report', reviewStatus: 'UNDER_REVIEW', caseId: null, case: null, region: null, attachments: [] },
];
const mapClient = {
  trIntegrationRun: { findFirst: async ({ where }) => where.status === 'SUCCEEDED' ? { completedAt: now, status: 'SUCCEEDED' } : { status: 'SUCCEEDED', completedAt: now } },
  trHotspot: { findMany: async () => [{ id: 'hotspot', source: 'NASA FIRMS', product: 'VIIRS', satellite: 'NOAA-20', instrument: 'VIIRS', latitude: -4, longitude: 113, acquiredAt: now, confidenceRaw: 'nominal', frp: 2, version: '1', fetchedAt: now }] },
  trPublicInformation: { findMany: async () => [{ id: 'publication', slug: 'active', title: 'Active confirmed case', publicCaseSnapshot: { id: 'case-1', number: 'C-1', verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'RESPONDING', publicPerimeter: { geometry: polygon, observedAt: now.toISOString(), source: 'Reviewed boundary', areaHectares: 1, revision: 1 } }, publicLocationMode: 'APPROVED_INCIDENT_PERIMETER', publicLatitude: null, publicLongitude: null, publishedAt: now, regions: [] }] },
  msMapFeature: { findMany: async () => [] },
  trReport: { findMany: async ({ where }) => where?.reporterId ? reports.filter(report => report.reporterId === where.reporterId) : reports },
  trCase: { findMany: async () => [{ id: 'case-1', number: 'C-1', title: 'Private confirmed case', latitude: -2, longitude: 110, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'RESPONDING', priority: 'HIGH', priorityReason: 'Reviewed', version: 2, openedAt: now, updatedAt: now, perimeter: polygon, perimeterRevision: 1 }] },
};
const citizenMap = await roleMap(owner, {}, mapClient, true);
assert.deepEqual(citizenMap.ownReports.map(report => report.id), ['own-private']);
assert.equal(JSON.stringify(citizenMap).includes('other-private'), false);
assert.equal(citizenMap.hotspots.length, 1);
const governmentMap = await roleMap({ ...owner, id: 'admin', role: 'ADMIN' }, {}, mapClient, true);
assert.deepEqual(governmentMap.privateReports.map(report => report.id).sort(), ['other-private', 'own-private']);
assert.deepEqual(governmentMap.privateCases.map(item => item.id), ['case-1']);
assert.equal(governmentMap.cases.some(item => item.id === 'case-1'), false);
assert.equal(governmentMap.hotspots.length, 1);
console.log('Latest notification ownership/read state/idempotency and role feed/map/news server dataset checks passed.');
