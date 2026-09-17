import assert from 'node:assert/strict';
import { requestLogger } from './dist/middleware/requestLogger.js';

const original = console.log;
const output = [];
console.log = value => output.push(value);
try {
  for (const [route, stage, expected] of [[undefined, 'database', '[database-guard]'], [undefined, 'routing', '[unmatched]'], ['/reports/:id', 'routing', '/reports/:id']]) {
    let finish;
    let next = false;
    requestLogger({ method: 'GET', route: route ? { path: route } : undefined, originalUrl: '/reports/private-id?token=private-secret' }, { statusCode: 503, locals: { requestStage: stage }, on: (event, callback) => { assert.equal(event, 'finish'); finish = callback; } }, () => { next = true; });
    assert.equal(next, true);
    finish();
    assert.ok(output.at(-1).includes(expected));
    assert.doesNotMatch(output.at(-1), /private-id|private-secret|token=/);
    assert.match(output.at(-1), /503/);
  }
} finally { console.log = original; }
console.log('Logger masking and pre-route database failure assertions passed.');
