import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
const { db, databaseAvailable, disconnect } = await import('./dist/config/db.js');
const { databaseGuard, errorHandler } = await import('./dist/middleware/guards.js');
const client = db();
const originalQuery = client.$queryRaw;
const originalWarn = console.warn;
const warnings = [];
console.warn = message => warnings.push(message);
let calls = 0;
let resolve;
let reject;
client.$queryRaw = () => {
  calls++;
  return new Promise((yes, no) => { resolve = yes; reject = no; });
};
const response = () => ({ locals: {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
try {
  const pending = Array.from({ length: 4 }, () => databaseAvailable());
  assert.equal(calls, 1);
  resolve([]);
  assert.deepEqual(await Promise.all(pending), [true, true, true, true]);
  let nextCalls = 0;
  const res = response();
  const failures = Array.from({ length: 4 }, () => databaseGuard({}, res, () => nextCalls++));
  const failed = Promise.allSettled(failures);
  assert.equal(calls, 2);
  reject(new Error('postgresql://private-user:private-secret@private-host/private-db'));
  for (const result of await failed) {
    assert.equal(result.status, 'rejected');
    errorHandler(result.reason, {}, res, () => assert.fail('error must not pass through'));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'SERVICE_UNAVAILABLE');
  }
  assert.equal(nextCalls, 0);
  assert.equal(res.locals.requestStage, 'database');
  assert.doesNotMatch(JSON.stringify([res.body, warnings]), /private-|postgresql:/);
  const recovered = databaseGuard({}, res, () => nextCalls++);
  assert.equal(calls, 3);
  resolve([]);
  await recovered;
  assert.equal(nextCalls, 1);
  assert.equal(res.locals.requestStage, 'routing');
  const fresh = databaseAvailable();
  assert.equal(calls, 4);
  resolve([]);
  assert.equal(await fresh, true);
} finally {
  client.$queryRaw = originalQuery;
  console.warn = originalWarn;
  await disconnect();
}
console.log('Readiness coalescing, fresh rechecks, fail-closed 503, redaction and recovery assertions passed.');
