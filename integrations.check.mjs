import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
process.env.FIRMS_MAP_KEY = 'isolated-test';
process.env.FIRMS_PRODUCTS = 'VIIRS_NOAA20_NRT';
process.env.FIRMS_AREA = '100,-10,120,10';
const { syncSource } = await import('./src/modules/integrations/integrations.service.ts');
const { parseFirms } = await import('./src/modules/integrations/parsing.ts');
const csv = 'latitude,longitude,acq_date,acq_time,satellite,instrument,confidence,frp,version\n' + Array.from({ length: 1001 }, (_, i) => `${i / 100},110,2026-09-16,1230,N20,VIIRS,n,5,2`).join('\n');
const rows = parseFirms(csv, 'VIIRS_NOAA20_NRT');
const originalFetch = globalThis.fetch;
let latest = null, expired = false, writes = 0, fetches = 0, failInsert = false;
let payload = csv;
const stored = new Map();
const batches = [], revisions = [], audits = [];
const runs = {
  updateMany: async ({ data }) => { if (data.failureCode === 'SOURCE_UNAVAILABLE') Object.assign(latest, data); return { count: 0 }; },
  findFirst: async () => latest,
  create: async ({ data }) => (latest = { ...data, id: 'test-run', status: 'RUNNING', startedAt: new Date() }),
  update: async ({ data }) => Object.assign(latest, data),
};
const client = {
  trIntegrationRun: runs,
  $transaction: async (callback, options) => {
    let locked = false, elapsed = 0, batch = 0;
    const tick = () => { elapsed += 220; if (elapsed > (options?.timeout ?? 5000)) throw Object.assign(new Error('Transaction expired'), { code: 'P2028' }); };
    const snapshot = new Map(stored);
    try {
      const result = await callback({
        trIntegrationRun: runs,
        $executeRaw: async () => 1,
        $queryRaw: async (sql, id) => { assert.match(sql.join('?'), /RUNNING.*8 minutes.*FOR UPDATE/); assert.equal(id, latest.id); locked = !expired; return locked ? [{ id }] : []; },
        trHotspot: {
          findMany: async ({ where }) => { assert.ok(locked); tick(); return [...stored.values()].filter(row => where.observationKey.in.includes(row.observationKey)); },
          createMany: async ({ data }) => { assert.ok(locked); tick(); batch += data.length; writes++; for (const row of data) { assert.ok(!stored.has(row.observationKey)); stored.set(row.observationKey, { ...row, id: row.observationKey }); } if (failInsert) throw new Error('insertion failure'); return { count: data.length }; },
          updateMany: async ({ where, data }) => { assert.ok(locked); tick(); writes++; assert.deepEqual(Object.keys(data), ['fetchedAt']); for (const [key, row] of stored) if (where.observationKey.in.includes(key)) stored.set(key, { ...row, ...data }); },
          update: async ({ where, data }) => { assert.ok(locked); tick(); writes++; assert.equal(data.caseId, undefined); stored.set(where.observationKey, { ...stored.get(where.observationKey), ...data }); },
        },
        trCase: { update: async ({ where, data }) => { assert.ok(locked); assert.deepEqual(data, { contextRevision: { increment: 1 }, version: { increment: 1 }, latestAnalysisId: null }); revisions.push(where.id); return { contextRevision: 2 }; } },
        trAuditLog: { create: async ({ data }) => audits.push(data) },
      });
      if (options && locked) batches.push(batch);
      return result;
    } catch (error) { stored.clear(); for (const [key, value] of snapshot) stored.set(key, value); throw error; }
  },
};
globalThis.fetch = async () => { fetches++; return new Response(payload); };
try {
  const first = await syncSource('FIRMS', {}, undefined, client);
  assert.equal(first.status, 'SUCCEEDED');
  assert.equal(first.imported, 1001);
  assert.equal(stored.size, 1001);
  assert.ok(batches.every(size => size <= 500));
  assert.equal(batches.length, 3);
  assert.equal(writes, 3);
  assert.equal(batches.at(-1), 1);
  const before = writes;
  await assert.rejects(syncSource('FIRMS', {}, undefined, client), { code: 'SYNC_RATE_LIMIT' });
  assert.equal(writes, before);
  assert.equal(fetches, 1);
  latest.startedAt = new Date(Date.now() - 86400001);
  stored.set(rows[0].observationKey, { ...stored.get(rows[0].observationKey), caseId: 'linked-case', frp: 1 });
  stored.set(rows[1].observationKey, { ...stored.get(rows[1].observationKey), caseId: 'linked-case', confidenceRaw: 'l' });
  const second = await syncSource('FIRMS', {}, undefined, client);
  assert.equal(second.imported, 0);
  assert.equal(second.deduplicated, 1001);
  assert.deepEqual(revisions, ['linked-case']);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].systemActor, 'source-sync');
  assert.equal(audits[0].details.runId, latest.id);
  assert.equal(stored.get(rows[0].observationKey).caseId, 'linked-case');
  assert.equal(writes - before, 5);
  latest.startedAt = new Date(Date.now() - 86400001);
  payload = `${csv}\n${csv.split('\n')[1]}`;
  stored.set(rows[0].observationKey, { ...stored.get(rows[0].observationKey), product: 'VIIRS_NOAA20_SP', raw: { alteredProvenance: true } });
  const third = await syncSource('FIRMS', {}, undefined, client);
  assert.equal(third.received, 1002);
  assert.equal(third.imported, 0);
  assert.equal(third.deduplicated, 1002);
  assert.equal(revisions.length, 2);
  assert.equal(stored.get(rows[0].observationKey).product, 'VIIRS_NOAA20_NRT');
  assert.deepEqual(stored.get(rows[0].observationKey).raw, rows[0].raw);
  assert.ok(latest.scope.observedFrom && latest.scope.observedTo);
  latest.startedAt = new Date(Date.now() - 86400001);
  payload = `${csv}\n20,110,2026-09-16,1230,N20,VIIRS,n,5,2`;
  failInsert = true;
  await assert.rejects(syncSource('FIRMS', {}, undefined, client));
  assert.equal(stored.size, 1001);
  assert.equal(latest.status, 'FAILED');
  assert.equal(latest.imported, 0);
  failInsert = false;
  latest.startedAt = new Date(Date.now() - 86400001);
  expired = true;
  const beforeExpired = writes;
  await assert.rejects(syncSource('FIRMS', {}, undefined, client));
  assert.equal(writes, beforeExpired);
  assert.equal(latest.status, 'FAILED');
  assert.equal(latest.imported, 0);
  console.log('FIRMS bounded batches, tail, deduplication, rate limit, expired lock and linked-case revisions passed; no network or database used.');
} finally { globalThis.fetch = originalFetch; }
