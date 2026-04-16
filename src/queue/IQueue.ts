export type MessageHandler<T> = (message: T) => Promise<void>;

export interface Queue<T> {
  readonly name: string;
  send(message: T): Promise<void>;
  // Start a long-running consumer. In dev this is an in-process poller;
  // in prod with Lambda this isn't called — the Lambda runtime invokes the handler directly.
  startConsumer(handler: MessageHandler<T>): void;
  stop(): Promise<void>;
}
