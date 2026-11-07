import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, mocks } from '../config';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Cloudflare R2 (S3 API) storage, or local disk when R2_* env vars are missing.
 * Local files are served by FilesController using an HMAC-signed, expiring URL.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger('Storage');
  private readonly s3?: S3Client;
  private readonly root = resolve(config.localStorageDir);

  constructor() {
    if (mocks.storage) {
      this.log.warn(`[MOCK] R2 not configured; storing files on local disk at ${this.root}`);
    } else {
      this.s3 = new S3Client({
        region: 'auto',
        endpoint: config.r2.endpoint ?? `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: config.r2.accessKeyId!, secretAccessKey: config.r2.secretAccessKey! },
      });
      this.log.log(`Using R2 bucket ${config.r2.bucket}`);
    }
  }

  get mode(): 'r2' | 'local' {
    return this.s3 ? 'r2' : 'local';
  }

  async put(key: string, body: Uint8Array, contentType = 'application/pdf'): Promise<{ key: string; sha256: string }> {
    const sha256 = sha256Hex(body);
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, Body: body, ContentType: contentType, Metadata: { sha256 } }),
      );
    } else {
      const path = this.localPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    return { key, sha256 };
  }

  async get(key: string): Promise<Uint8Array> {
    if (this.s3) {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }));
      return res.Body!.transformToByteArray();
    }
    return new Uint8Array(await readFile(this.localPath(key)));
  }

  async signedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    if (this.s3) {
      return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }), { expiresIn: expiresInSeconds });
    }
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = this.sign(key, exp);
    return `${config.publicApiUrl}/api/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
  }

  verifyLocalSignature(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', config.signingSecret).update(`${key}:${exp}`).digest('hex');
  }

  private localPath(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }
}
