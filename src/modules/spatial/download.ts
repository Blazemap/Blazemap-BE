import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const defaultGeofabrikUrl = 'https://download.geofabrik.de/asia/indonesia/kalimantan-latest.osm.pbf';
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type DownloadOptions = { sourceUrl: string; userAgent: string; maxBytes: number; temporaryRoot?: string; fetchImpl?: Fetch };

function source(sourceUrl: string) {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:') throw new Error('OSM source URL must use HTTPS');
  if (!url.pathname.endsWith('.osm.pbf')) throw new Error('OSM source URL must identify an .osm.pbf extract');
  return url;
}
function headers(userAgent: string) {
  const value = userAgent.trim();
  if (value.length < 10 || value.length > 256 || !/(https?:\/\/|mailto:|@)/i.test(value)) throw new Error('SPATIAL_IMPORT_USER_AGENT must identify Blazemap and include operator contact');
  return { 'User-Agent': value, Accept: 'application/octet-stream, text/plain;q=0.9' };
}
function limit(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024) throw new Error('Invalid OSM download limit');
  return maxBytes;
}
function sourceDate(response: Response) {
  const raw = response.headers.get('last-modified');
  const value = raw ? new Date(raw) : new Date(Number.NaN);
  if (!Number.isFinite(value.getTime()) || value > new Date()) throw new Error('Geofabrik response has an invalid Last-Modified header');
  return value;
}
function contentLength(response: Response, maxBytes: number) {
  const raw = response.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Geofabrik response has an invalid Content-Length header');
  if (value > maxBytes) throw new Error('Geofabrik extract exceeds configured download limit');
  return value;
}
async function boundedResponseText(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) throw new Error(`Geofabrik metadata request failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Geofabrik checksum response exceeds configured limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseMd5(value: string, expectedFilename: string) {
  const match = /^([a-f\d]{32})\s+\*?([^\r\n]+)\s*$/i.exec(value.trim());
  if (!match || match[2] !== expectedFilename) throw new Error('Invalid Geofabrik MD5 manifest');
  return match[1]!.toLowerCase();
}
async function expectedChecksum(url: URL, userAgent: string, fetchImpl: Fetch) {
  const manifestUrl = new URL(`${url.href}.md5`);
  const response = await fetchImpl(manifestUrl, { headers: { ...headers(userAgent), Accept: 'text/plain' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  return parseMd5(await boundedResponseText(response, 4096), basename(url.pathname));
}

export async function inspectRemoteExtract(options: DownloadOptions) {
  const url = source(options.sourceUrl);
  const maxBytes = limit(options.maxBytes);
  const fetchImpl = options.fetchImpl ?? fetch;
  const [checksum, response] = await Promise.all([
    expectedChecksum(url, options.userAgent, fetchImpl),
    fetchImpl(url, { method: 'HEAD', headers: headers(options.userAgent), redirect: 'follow', signal: AbortSignal.timeout(30000) }),
  ]);
  if (!response.ok) throw new Error(`Geofabrik header request failed (${response.status})`);
  return { checksum, contentLength: contentLength(response, maxBytes), sourceDate: sourceDate(response), sourceUrl: url.href };
}

export async function downloadVerifiedExtract(options: DownloadOptions) {
  const url = source(options.sourceUrl);
  const maxBytes = limit(options.maxBytes);
  const fetchImpl = options.fetchImpl ?? fetch;
  const checksum = await expectedChecksum(url, options.userAgent, fetchImpl);
  const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'blazemap-osm-'));
  const filePath = join(directory, basename(url.pathname));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const response = await fetchImpl(url, { headers: headers(options.userAgent), redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Geofabrik extract request failed (${response.status})`);
    const expectedLength = contentLength(response, maxBytes);
    const modifiedAt = sourceDate(response);
    const hash = createHash('md5');
    let bytes = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) { callback(new Error('Geofabrik extract exceeds configured download limit')); return; }
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), meter, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
    if (expectedLength !== null && bytes !== expectedLength) throw new Error('Geofabrik extract length does not match response header');
    if (!bytes) throw new Error('Geofabrik extract is empty');
    const actual = hash.digest('hex');
    if (actual !== checksum) throw new Error('Geofabrik extract checksum mismatch');
    return { filePath, checksum, sourceDate: modifiedAt, sourceUrl: url.href, bytes, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
