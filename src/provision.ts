import { parseArgs } from 'node:util';
import { z } from 'zod';
import { db, disconnect } from './config/index.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, role: { type: 'string' }, active: { type: 'string' }, confirm: { type: 'string' }, publish: { type: 'string' }, operator: { type: 'string' }, reason: { type: 'string' }, mandate: { type: 'string' } } });
const boolean = z.enum(['true', 'false']).transform(v => v === 'true');
try {
  const input = z.object({ email: z.email(), role: z.enum(['USER', 'ADMIN']), active: boolean, confirm: boolean, publish: boolean, operator: z.string().min(3), reason: z.string().min(5), mandate: z.string().min(3) }).parse(values);
  if (input.role !== 'ADMIN' && (input.confirm || input.publish)) throw new Error();
  await db().$transaction(async tx => {
    const user = await tx.msUser.findUniqueOrThrow({ where: { email: input.email.toLowerCase() } });
    await tx.$queryRaw`SELECT id FROM "MsUser" WHERE id = ${user.id} FOR UPDATE`;
    await tx.msUser.update({ where: { id: user.id }, data: { role: input.role, active: input.active, canConfirmIncidents: input.confirm, canPublishInformation: input.publish } });
    await tx.trSession.deleteMany({ where: { userId: user.id } });
    await tx.trAuditLog.create({ data: { systemActor: input.operator, action: 'ACCOUNT_AUTHORITY_PROVISIONED', targetType: 'USER', targetId: user.id, reason: input.reason, details: { mandate: input.mandate, role: input.role, active: input.active, canConfirmIncidents: input.confirm, canPublishInformation: input.publish } } });
  });
  console.log('Authority updated; existing sessions revoked.');
} catch { console.error('Provisioning failed. Supply an existing account and all required authority arguments.'); process.exitCode = 1; }
finally { await disconnect(); }
