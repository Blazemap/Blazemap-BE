import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
process.env.DATABASE_URL = '';
const { seedTestAccounts, testIdentities } = await import('./src/seed-test-accounts.ts');
const dir = await mkdtemp(join(tmpdir(), 'blazemap-account-check-'));
let users = [], audits = [], transactions = 0;
const client = {
  msUser: { findMany: async () => users },
  $transaction: async callback => {
    transactions++;
    const pending = [], events = [];
    await callback({
      $executeRaw: async () => 1,
      msUser: {
        findMany: async () => users,
        create: async ({ data }) => pending.push({ ...data, accounts: [data.accounts.create] }),
      },
      trAuditLog: { create: async ({ data }) => events.push(data) },
    });
    users.push(...pending); audits.push(...events);
  },
};
try {
  const file = join(dir, '.env.test-accounts');
  const first = await seedTestAccounts(client, file);
  assert.equal(first.created, 7);
  assert.equal(users.filter(user => user.role === 'ADMIN').length, 1);
  assert.equal(audits.length, 7);
  assert.ok(audits.every(event => event.systemActor === 'test-account-seeder'));
  assert.ok(users.every(user => user.emailVerified && !user.canConfirmIncidents && !user.canPublishInformation));
  const original = await readFile(file, 'utf8');
  const credentials = JSON.parse(original);
  assert.equal(new Set(credentials.accounts.map(account => account.password)).size, 7);
  assert.ok(credentials.accounts.every(account => account.password.length >= 20));
  assert.equal((await seedTestAccounts(client, file)).verified, 7);
  assert.equal(transactions, 1);
  assert.equal(await readFile(file, 'utf8'), original);
  const missingFile = join(dir, 'missing-parent', 'credentials');
  const saved = users;
  users = [];
  await assert.rejects(seedTestAccounts(client, missingFile));
  assert.equal(transactions, 1);
  const occupied = join(dir, 'occupied');
  await writeFile(occupied, 'do not overwrite');
  await assert.rejects(seedTestAccounts(client, occupied));
  assert.equal(await readFile(occupied, 'utf8'), 'do not overwrite');
  users = [{ ...saved[0], name: 'Real account' }];
  await assert.rejects(seedTestAccounts(client, join(dir, 'collision')));
  assert.equal(transactions, 1);
  users = saved;
  users[0].accounts[0].password = await hashPassword('different-password-not-a-reset');
  await assert.rejects(seedTestAccounts(client, file));
  users = [];
  const failureFile = join(dir, 'rollback');
  await assert.rejects(seedTestAccounts({ ...client, $transaction: async () => { throw new Error('rollback'); } }, failureFile));
  await assert.rejects(readFile(failureFile), { code: 'ENOENT' });
  assert.equal(testIdentities.length, 7);
  console.log('Account fixtures: seven identities, unique passwords, official hash verification, rerun safety, collisions, file failure and rollback passed.');
} finally { await rm(dir, { recursive: true, force: true }); }
