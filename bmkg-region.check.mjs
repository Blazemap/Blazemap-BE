import assert from 'node:assert/strict';
import { caseRegionSchema } from './src/types/index.ts';
import { listRegions, updateCaseRegion } from './src/modules/admin/index.ts';

assert.equal(caseRegionSchema.safeParse({ version: 2, regionId: 'mapped-region', reason: 'Operator selected the verified forecast region.' }).success, true);
assert.equal(caseRegionSchema.safeParse({ version: 2, regionId: null, reason: 'Remove an incorrect operator mapping.' }).success, true);
assert.equal(caseRegionSchema.safeParse({ version: 2, regionId: undefined, reason: 'Missing selection is invalid.' }).success, false);

let listQuery;
const regions = await listRegions({ search: 'kapuas', bmkgMapped: 'true' }, {
  msRegion: { findMany: async query => { listQuery = query; return [{ id: 'mapped-region', name: 'Verified ADM4', code: '61.01.01.1001', level: 4, timezone: 'Asia/Pontianak', bmkgAdm4: '61.01.01.1001' }]; } },
});
assert.deepEqual(listQuery.where, { verifiedAt: { not: null }, bmkgAdm4: { not: null }, level: 4, name: { contains: 'kapuas', mode: 'insensitive' } });
assert.deepEqual(regions, [{ id: 'mapped-region', name: 'Verified ADM4', code: '61.01.01.1001', level: 4, timezone: 'Asia/Pontianak', bmkgMapped: true }]);
assert.equal(JSON.stringify(regions).includes('bmkgAdm4'), false);

const actor = { id: 'admin' };
let selectedRegion = null;
let auditDetails;
const current = { id: 'case', regionId: null, version: 2, contextRevision: 1 };
const tx = {
  $queryRaw: async () => {},
  msUser: { findUnique: async () => ({ id: actor.id, role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
  msRegion: { findFirst: async ({ where }) => where.id === 'mapped-region' && where.level === 4 && where.bmkgAdm4?.not === null ? { id: 'mapped-region' } : null },
  trCase: {
    findUniqueOrThrow: async () => current,
    update: async ({ where, data }) => { assert.deepEqual(where, { id: 'case', version: 2 }); selectedRegion = data.regionId; return { ...current, regionId: data.regionId, version: 3, contextRevision: 2 }; },
  },
  trAuditLog: { create: async ({ data }) => { auditDetails = data; } },
};
const client = { $transaction: callback => callback(tx) };
const updated = await updateCaseRegion(actor, 'case', { version: 2, regionId: 'mapped-region', reason: 'Operator selected the verified forecast region.' }, client);
assert.equal(selectedRegion, 'mapped-region');
assert.equal(updated.version, 3);
assert.equal(auditDetails.action, 'CASE_FORECAST_REGION_CHANGED');
assert.deepEqual(auditDetails.details, { before: { regionId: null }, after: { regionId: 'mapped-region' } });
await assert.rejects(updateCaseRegion(actor, 'case', { version: 2, regionId: 'unknown', reason: 'Operator selected an unavailable forecast region.' }, { $transaction: callback => callback({ ...tx, msRegion: { findFirst: async () => null } }) }), { code: 'INVALID_REGION' });

console.log('Operator-only verified BMKG region selection and sanitized listing checks passed.');
