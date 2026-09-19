import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.DATABASE_URL = '';
const { assignTeam, updateAssignment } = await import('../src/modules/admin/admin.service.ts');
const actor = { id: 'admin', role: 'ADMIN', active: true, emailVerified: true };
const body = () => ({ version: 1, teamId: 'team', notes: 'Ground check for smoke', reason: 'Human requested ground check', idempotencyKey: randomUUID() });
function fixture(overrides = {}) {
  const rows = [], audits = [], locks = [];
  const incident = { id: 'case', version: 1, handlingStatus: 'OPEN', verificationStatus: 'UNVERIFIED', ...overrides.case };
  let queue = Promise.resolve();
  const tx = {
    $queryRaw: async (sql, ...values) => { locks.push([sql.join('?'), values]); return []; },
    msUser: { findUnique: async () => ({ ...actor, ...overrides.actor }) },
    msTeam: { findFirst: async () => overrides.inactive ? null : { id: 'team', active: true } },
    trCase: { findUniqueOrThrow: async () => incident, update: async () => { incident.version++; return incident; } },
    trAuditLog: { findFirst: async () => overrides.sample ? { id: 'sample' } : null, create: async ({ data }) => { audits.push(data); return data; } },
    trOperationalUpdate: { findFirst: async () => ({ condition: 'AVAILABLE', observedAt: new Date(), ...overrides.update }) },
    trAssignment: {
      findUnique: async ({ where }) => rows.find(row => where.id ? row.id === where.id : row.idempotencyKey === where.idempotencyKey) ?? null,
      findUniqueOrThrow: async ({ where }) => { const row = rows.find(row => row.id === where.id); if (!row) throw Error('missing'); return { ...row }; },
      count: async () => rows.filter(row => ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'].includes(row.status)).length,
      create: async ({ data }) => { const row = { ...data, id: randomUUID(), version: 1, status: 'ASSIGNED' }; rows.push(row); return row; },
      updateMany: async ({ where, data }) => { const row = rows.find(row => row.id === where.id && row.version === where.version); if (!row) return { count: 0 }; row.status = data.status; row.version++; return { count: 1 }; },
    },
  };
  const client = { $transaction: callback => { const result = queue.then(() => callback(tx)); queue = result.catch(() => {}); return result; } };
  return { client, rows, audits, locks, incident };
}
const code = expected => error => error.code === expected;
test('creation requires reviewed version and task description', async () => {
  const f = fixture();
  for (const input of [{ ...body(), version: undefined }, { ...body(), notes: null }, { ...body(), notes: ' ' }]) await assert.rejects(() => assignTeam(actor, 'case', input, f.client));
});
for (const [name, overrides, expected] of [
  ['citizen', { actor: { role: 'USER' } }, 'FORBIDDEN'],
  ['inactive actor', { actor: { active: false } }, 'UNAUTHORIZED'],
  ['unverified actor', { actor: { emailVerified: false } }, 'FORBIDDEN'],
  ['stale case', { case: { version: 2 } }, 'VERSION_CONFLICT'],
  ['closed', { case: { handlingStatus: 'CLOSED' } }, 'INVALID_TRANSITION'],
  ['not fire', { case: { verificationStatus: 'NOT_FIRE' } }, 'INVALID_TRANSITION'],
  ['inactive team', { inactive: true }, 'INVALID_TEAM'],
  ['sample', { sample: true }, 'SAMPLE_DATA'],
  ['unknown', { update: { condition: 'UNKNOWN' } }, 'TEAM_STATUS_UNKNOWN'],
  ['stale availability', { update: { observedAt: new Date(Date.now() - 86400001) } }, 'TEAM_STATUS_UNKNOWN'],
  ['future availability', { update: { observedAt: new Date(Date.now() + 60000) } }, 'TEAM_STATUS_UNKNOWN'],
]) test(`rejects ${name}`, async () => { const f = fixture(overrides); await assert.rejects(() => assignTeam(actor, 'case', body(), f.client), code(expected)); assert.equal(f.rows.length, 0); });
test('unverified and confirmed cases allow explicit assignments without changing verification or handling', async () => {
  for (const verificationStatus of ['UNVERIFIED', 'CONFIRMED_FIRE']) {
    const f = fixture({ case: { verificationStatus } });
    await assignTeam(actor, 'case', body(), f.client);
    assert.equal(f.incident.verificationStatus, verificationStatus); assert.equal(f.incident.handlingStatus, 'OPEN');
    assert.equal(f.audits[0].actorId, actor.id); assert.equal(f.audits[0].reason, 'Human requested ground check');
  }
});
test('same request replays; another payload conflicts; concurrent assignments cannot reserve the same team', async () => {
  const f = fixture(), input = body();
  const [a, b] = await Promise.all([assignTeam(actor, 'case', input, f.client), assignTeam(actor, 'case', input, f.client)]);
  assert.equal(a.id, b.id); assert.equal(f.rows.length, 1);
  await assert.rejects(() => assignTeam(actor, 'case', { ...input, notes: 'Changed task' }, f.client), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(() => assignTeam(actor, 'other-case', { ...body(), version: 2 }, f.client), code('TEAM_BUSY'));
  assert.ok(f.locks.some(([sql]) => sql.includes('MsTeam') && sql.includes('FOR UPDATE')));
});
test('only forward lifecycle or cancellation; versions checked; terminal states immutable', async () => {
  const f = fixture(); const item = await assignTeam(actor, 'case', body(), f.client);
  for (const status of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']) await assert.rejects(() => updateAssignment(actor, item.id, { version: 1, status, reason: 'Explicit operator update' }, f.client), code('INVALID_TRANSITION'));
  await assert.rejects(() => updateAssignment(actor, item.id, { version: 2, status: 'ACCEPTED', reason: 'Explicit operator update' }, f.client), code('VERSION_CONFLICT'));
  for (const [version, status] of [[1, 'ACCEPTED'], [2, 'IN_PROGRESS'], [3, 'COMPLETED']]) await updateAssignment(actor, item.id, { version, status, reason: 'Explicit operator update' }, f.client);
  await assert.rejects(() => updateAssignment(actor, item.id, { version: 4, status: 'CANCELLED', reason: 'Explicit operator update' }, f.client), code('INVALID_TRANSITION'));
});
test('cancellation never overwrites a later unavailable observation', async () => {
  const overrides = {}, f = fixture(overrides);
  const item = await assignTeam(actor, 'case', body(), f.client);
  overrides.update = { condition: 'UNAVAILABLE' };
  await updateAssignment(actor, item.id, { version: 1, status: 'CANCELLED', reason: 'Ground check cancelled' }, f.client);
  await assert.rejects(() => assignTeam(actor, 'case', { ...body(), version: f.incident.version }, f.client), code('TEAM_STATUS_UNKNOWN'));
});
test('simultaneous independent requests reserve only one team', async () => {
  const f = fixture();
  const results = await Promise.allSettled([assignTeam(actor, 'case', body(), f.client), assignTeam({ ...actor, id: 'other-admin' }, 'other-case', { ...body(), version: 2 }, f.client)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'TEAM_BUSY');
});
test('cancellation releases reservation but does not invent availability', async () => {
  const f = fixture(); const item = await assignTeam(actor, 'case', body(), f.client);
  await updateAssignment(actor, item.id, { version: 1, status: 'CANCELLED', reason: 'Ground check cancelled' }, f.client);
  await assignTeam(actor, 'case', { ...body(), version: f.incident.version }, f.client);
  assert.equal(f.rows.length, 2);
});
