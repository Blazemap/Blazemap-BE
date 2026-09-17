import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { PrismaClient } from './generated/prisma/client.js';
import { db, disconnect } from './config/db.js';

export const testIdentities = [
  { email: 'govt-test@blazemap.test', name: 'TEST Government Login Fixture (No Mandate)', role: 'ADMIN' as const },
  { email: 'user-test@blazemap.test', name: 'TEST Regular Login Fixture', role: 'USER' as const },
  ...Array.from({ length: 5 }, (_, index) => ({ email: `reporter${String(index + 1).padStart(2, '0')}@blazemap.test`, name: `TEST Reporter ${String(index + 1).padStart(2, '0')} Login Fixture`, role: 'USER' as const })),
];
const credentialSchema = z.strictObject({ purpose: z.literal('TEST_LOGIN_FIXTURES_ONLY_NO_OPERATIONAL_MANDATE'), accounts: z.array(z.strictObject({ id: z.string(), email: z.email(), name: z.string(), role: z.enum(['USER', 'ADMIN']), password: z.string().min(20).max(128) })).length(7) });
const where = { email: { in: testIdentities.map(identity => identity.email) } };

export async function seedTestAccounts(client: PrismaClient, file: string) {
  const existing = await client.msUser.findMany({ where, include: { accounts: true } });
  if (existing.length) {
    const saved = credentialSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (existing.length !== 7 || new Set(saved.accounts.map(account => account.email)).size !== 7) throw new Error('Fixture collision');
    for (const identity of testIdentities) {
      const user = existing.find(user => user.email === identity.email);
      const credential = saved.accounts.find(account => account.email === identity.email);
      const account = user?.accounts.find(account => account.providerId === 'credential');
      if (!user || !credential || user.name !== identity.name || credential.name !== identity.name || user.role !== identity.role || credential.role !== identity.role || credential.id !== user.id || !user.active || !user.emailVerified || user.canConfirmIncidents || user.canPublishInformation || user.accounts.length !== 1 || account?.accountId !== user.id || !account.password || !await verifyPassword({ hash: account.password, password: credential.password })) throw new Error('Fixture collision or credentials unavailable');
    }
    return { created: 0, verified: 7 };
  }
  const accounts = testIdentities.map(identity => ({ ...identity, id: randomUUID(), password: randomBytes(24).toString('base64url') }));
  const hashes = await Promise.all(accounts.map(account => hashPassword(account.password)));
  const handle = await open(file, 'wx', 0o600);
  let transactionAttempted = false;
  try {
    if (process.platform === 'win32') {
      const owner = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${owner}:(F)`], { stdio: 'ignore', windowsHide: true });
    }
    await handle.writeFile(JSON.stringify({ purpose: 'TEST_LOGIN_FIXTURES_ONLY_NO_OPERATIONAL_MANDATE', accounts }, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    transactionAttempted = true;
    await client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('test-account-seeder'))`;
      if ((await tx.msUser.findMany({ where, select: { id: true } })).length) throw new Error('Fixture collision');
      for (const [index, account] of accounts.entries()) {
        const { password: _password, ...identity } = account;
        await tx.msUser.create({ data: { ...identity, active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false, accounts: { create: { id: randomUUID(), accountId: account.id, providerId: 'credential', password: hashes[index]! } } } });
        await tx.trAuditLog.create({ data: { systemActor: 'test-account-seeder', action: 'TEST_ACCOUNT_CREATED', targetType: 'USER', targetId: account.id, reason: 'Explicitly authorized test login fixture; exact .test identity verification bypass only; no operational mandate', details: { email: account.email, role: account.role, emailVerified: true, verificationBasis: 'EXPLICIT_TEST_FIXTURE_BYPASS', canConfirmIncidents: false, canPublishInformation: false } } });
      }
    }, { maxWait: 10000, timeout: 60000 });
  } catch {
    await handle.close().catch(() => {});
    let safeToRemove = !transactionAttempted;
    if (transactionAttempted) {
      try { safeToRemove = !(await client.msUser.findMany({ where: { id: { in: accounts.map(account => account.id) } }, select: { id: true } })).length; }
      catch { safeToRemove = false; }
    }
    if (safeToRemove) await unlink(file);
    throw new Error('Fixture seeding failed; existing credentials are never overwritten; retained file requires inspection if commit outcome is uncertain');
  }
  return { created: 7, verified: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean' }, 'confirm-test-accounts': { type: 'boolean' } } });
    if (!values.apply || !values['confirm-test-accounts']) throw new Error('Explicit flags required');
    const file = resolve('.env.test-accounts');
    const result = await seedTestAccounts(db(), file);
    const verified = await seedTestAccounts(db(), file);
    const auditCount = await db().trAuditLog.count({ where: { systemActor: 'test-account-seeder', action: 'TEST_ACCOUNT_CREATED', targetId: { in: (await db().msUser.findMany({ where, select: { id: true } })).map(user => user.id) } } });
    console.log(JSON.stringify({ created: result.created, verified: verified.verified, auditCount, credentialsFile: file, identities: testIdentities.map(({ email, role }) => ({ email, role })), canConfirmIncidents: false, canPublishInformation: false }));
  } catch { console.error('Test account seed refused or failed; requires --apply --confirm-test-accounts, no identity collisions, and a safe local credentials file. Existing credentials were not reset.'); process.exitCode = 1; }
  finally { await disconnect(); }
}
