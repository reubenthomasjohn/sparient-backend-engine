import { logger } from '../utils/logger';
import { MessageHandler, Queue } from './IQueue';

// Dev-only FIFO queue. Handler errors are logged and the message is dropped — workers
// persist failure state to DB themselves, so the queue doesn't need its own retry semantics.
// For production SQS parity (visibility timeout, redrive, DLQ) use SqsQueue.
export class InMemoryQueue<T> implements Queue<T> {
  private readonly buffer: T[] = [];
  private interval: NodeJS.Timeout | null = null;

  constructor(public readonly name: string, private readonly pollMs = 250) {}

  async send(message: T): Promise<void> {
    this.buffer.push(message);
  }

  startConsumer(handler: MessageHandler<T>): void {
    if (this.interval) return;
    logger.info(`InMemoryQueue(${this.name}): consumer started`);

    this.interval = setInterval(async () => {
      const message = this.buffer.shift();
      if (!message) return;
      try {
        await handler(message);
      } catch (err) {
        logger.error(`InMemoryQueue(${this.name}): handler threw, dropping message`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}
