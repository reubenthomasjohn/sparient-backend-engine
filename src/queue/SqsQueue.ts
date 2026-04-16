import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { logger } from '../utils/logger';
import { MessageHandler, Queue } from './IQueue';

// Long-poll SQS consumer. Messages that throw are left undeleted — SQS visibility timeout
// will redrive them. Configure the queue's maxReceiveCount + DLQ for terminal failures.
export class SqsQueue<T> implements Queue<T> {
  private readonly client: SQSClient;
  private stopped = false;
  private pollLoopPromise: Promise<void> | null = null;

  constructor(
    public readonly name: string,
    private readonly queueUrl: string,
    region: string,
  ) {
    this.client = new SQSClient({ region });
  }

  async send(message: T): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }

  startConsumer(handler: MessageHandler<T>): void {
    if (this.pollLoopPromise) return;
    logger.info(`SqsQueue(${this.name}): consumer started`, { queueUrl: this.queueUrl });
    this.pollLoopPromise = this.pollLoop(handler);
  }

  private async pollLoop(handler: MessageHandler<T>): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        );

        for (const m of res.Messages ?? []) {
          if (!m.Body || !m.ReceiptHandle) continue;
          try {
            const body = JSON.parse(m.Body) as T;
            await handler(body);
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: m.ReceiptHandle,
              }),
            );
          } catch (err) {
            logger.error(`SqsQueue(${this.name}): handler failed, leaving for SQS redrive`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.error(`SqsQueue(${this.name}): poll loop error`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // Back off briefly on infra errors so we don't spin
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollLoopPromise) await this.pollLoopPromise;
    this.client.destroy();
  }
}
