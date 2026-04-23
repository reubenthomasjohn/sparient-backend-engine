import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketNotificationConfigurationCommand,
} from '@aws-sdk/client-s3';
import { config } from '../../config';
import { getBucketName } from '../../config/s3Bucket';
import { S3_PREFIX } from '../../config/s3Prefixes';
import { logger } from '../../utils/logger';

const s3 = new S3Client({ region: config.aws.region });

// Creates and configures an S3 bucket for a new institution.
// Called during institution onboarding. Idempotent — re-running on an existing
// bucket updates the notification config without error.

async function createBucket(bucketName: string): Promise<void> {
  await s3.send(new CreateBucketCommand({
    Bucket: bucketName,
    CreateBucketConfiguration: {
      LocationConstraint: config.aws.region as 'us-east-2',
    },
  }));
  logger.info('InstitutionBucket: created', { bucketName });
}

async function blockPublicAccess(bucketName: string): Promise<void> {
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucketName,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  }));
  logger.info('InstitutionBucket: public access blocked', { bucketName });
}

async function configureResponseNotification(
  bucketName: string,
  sqsArn: string,
): Promise<void> {
  await s3.send(new PutBucketNotificationConfigurationCommand({
    Bucket: bucketName,
    NotificationConfiguration: {
      QueueConfigurations: [
        {
          QueueArn: sqsArn,
          Events: ['s3:ObjectCreated:*'],
          Filter: {
            Key: {
              FilterRules: [
                { Name: 'prefix', Value: `${S3_PREFIX.RESPONSES}/` },
                { Name: 'suffix', Value: '.json' },
              ],
            },
          },
        },
      ],
    },
  }));
  logger.info('InstitutionBucket: response notification configured', { bucketName, sqsArn });
}

export async function provisionInstitutionBucket(
  institutionId: string,
  s3BucketOverride?: string | null,
): Promise<string> {
  const bucketName = getBucketName(institutionId, s3BucketOverride);

  await createBucket(bucketName);
  await blockPublicAccess(bucketName);

  // SQS ARN for the responses queue — passed via env var from Terraform.
  const sqsArn = config.queue.responsesQueueArn;
  if (sqsArn) {
    await configureResponseNotification(bucketName, sqsArn);
  } else {
    logger.warn('InstitutionBucket: SQS_RESPONSES_QUEUE_ARN not set, skipping notification config');
  }

  logger.info('InstitutionBucket: provisioned', { bucketName });
  return bucketName;
}
