import { Readable } from 'stream';
import { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../../config';
import { S3_PREFIX } from '../../config/s3Prefixes';
import { logger } from '../../utils/logger';

export interface SourceKeyParams {
  institutionId: string;
  canvasCourseId: string;
  canvasFileId: string;
  modifiedAt: Date;
  fileName: string;
}

class S3Service {
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({ region: config.aws.region });
  }

  get bucket(): string {
    return config.aws.s3Bucket;
  }

  // Streams body to S3 via multipart upload.
  async uploadSourceFileStream(key: string, body: Readable, mimeType: string): Promise<void> {
    const fullKey = `${S3_PREFIX.SOURCE}/${key}`;
    logger.debug('S3: streaming source file', { bucket: this.bucket, key: fullKey });

    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: fullKey,
        Body: body,
        ContentType: mimeType,
      },
    }).done();

    logger.info('S3: source file uploaded', { key: fullKey });
  }

  async getSourceFileBytes(key: string): Promise<Uint8Array> {
    const fullKey = `${S3_PREFIX.SOURCE}/${key}`;
    const r = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
    }));
    if (!r.Body) throw new Error(`S3 GetObject returned no body for key ${fullKey}`);
    return r.Body.transformToByteArray();
  }

  async putJson(prefix: string, key: string, body: unknown): Promise<void> {
    const fullKey = `${prefix}/${key}`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
      Body: JSON.stringify(body, null, 2),
      ContentType: 'application/json',
    }));
    logger.info('S3: json written', { bucket: this.bucket, key: fullKey });
  }

  async getJson<T>(prefix: string, key: string): Promise<T> {
    const fullKey = `${prefix}/${key}`;
    const r = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
    }));
    if (!r.Body) throw new Error(`S3 GetObject returned no body for key ${fullKey}`);
    const text = await r.Body.transformToString();
    return JSON.parse(text) as T;
  }

  async fileExists(prefix: string, key: string): Promise<boolean> {
    const fullKey = `${prefix}/${key}`;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fullKey }));
      return true;
    } catch {
      return false;
    }
  }

  // Content-addressed key (without prefix — caller prepends the appropriate prefix).
  buildSourceKey(params: SourceKeyParams): string {
    const version = params.modifiedAt.getTime();
    return `${params.institutionId}/${params.canvasCourseId}/${params.canvasFileId}/v-${version}/${params.fileName}`;
  }
}

export const s3Service = new S3Service();
