import { Readable } from 'stream';
import { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../../config';
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
    this.client = new S3Client({
      region: config.aws.region,
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      },
    });
  }

  // Streams body to S3 via multipart upload — works for files of any size without buffering.
  async uploadSourceFileStream(key: string, body: Readable, mimeType: string): Promise<void> {
    logger.debug('S3: streaming source file', { bucket: config.aws.s3SourceBucket, key });

    await new Upload({
      client: this.client,
      params: {
        Bucket: config.aws.s3SourceBucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
      },
    }).done();

    logger.info('S3: source file uploaded', { key });
  }

  // Small JSON write (request.json or response.json). Not streamed — payloads are KBs.
  async putJson(bucket: string, key: string, body: unknown): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: 'application/json',
    }));
    logger.info('S3: json written', { bucket, key });
  }

  async getJson<T>(bucket: string, key: string): Promise<T> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await r.Body!.transformToString();
    return JSON.parse(text) as T;
  }

  async fileExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  // Content-addressed: the modifiedAt lives in the key, so editing a file produces a new
  // key rather than overwriting the in-flight object. No reliance on S3 bucket versioning.
  buildSourceKey(params: SourceKeyParams): string {
    const version = params.modifiedAt.getTime();
    return `${params.institutionId}/courses/${params.canvasCourseId}/files/${params.canvasFileId}/v-${version}/${params.fileName}`;
  }
}

export const s3Service = new S3Service();
