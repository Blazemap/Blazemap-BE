import assert from 'node:assert/strict';
process.env.DATABASE_URL = '';
const { scenarioCopy, sourceUrl, photoSources, scenarioActor } = await import('./src/seed-sample-images.ts');
assert.equal(photoSources.length, 2);
assert.equal(scenarioActor, 'sample-report-image-seeder-v2');
for (let index = 0; index < 10; index++) {
  const copy = scenarioCopy(index);
  assert.match(copy.description, /Illustrative scenario/);
  assert.match(copy.description, /not evidence/);
  assert.equal(copy.history.length, 2);
  assert.ok(copy.history.every(message => message.startsWith('Illustrative scenario')));
  assert.doesNotMatch(JSON.stringify(copy), /\b(?:TEST|DEMO)\b/);
}
assert.throws(() => scenarioCopy(10));
for (const url of ['http://upload.wikimedia.org/a', 'https://evil.example/a', 'https://upload.wikimedia.org.evil.example/a', 'https://user:password@upload.wikimedia.org/a']) assert.throws(() => sourceUrl(url));
assert.equal(sourceUrl('https://upload.wikimedia.org/a').hostname, 'upload.wikimedia.org');
console.log('Scenario copy, bounded source list and photo URL guards passed.');
