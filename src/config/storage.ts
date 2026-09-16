import { S3Client } from '@aws-sdk/client-s3';
import { env, uploadsAvailable } from './env.js';
import { unavailable } from '../utils/index.js';
let client: S3Client | undefined;
export function storage() {
  if (!uploadsAvailable) throw unavailable('Uploads');
  return client ??= new S3Client({
    region: env.S3_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 2,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
