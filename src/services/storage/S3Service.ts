import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../../config';
import { logger } from '../../utils/logger';

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

  async uploadSourceFile(key: string, body: Buffer, mimeType: string): Promise<void> {
    logger.debug('S3: uploading source file', { bucket: config.aws.s3SourceBucket, key });

    await this.client.send(
      new PutObjectCommand({
        Bucket: config.aws.s3SourceBucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
      }),
    );

    logger.info('S3: source file uploaded', { key });
  }

  async fileExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  buildSourceKey(
    institutionSlug: string,
    canvasCourseId: string,
    canvasFileId: string,
    fileName: string,
  ): string {
    return `${institutionSlug}/courses/${canvasCourseId}/files/${canvasFileId}/${fileName}`;
  }
}

export const s3Service = new S3Service();
