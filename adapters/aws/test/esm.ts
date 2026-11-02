import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda';

/**
 * What the Lambda event source mapping does, for the stand-in queue: long poll, hand each message to the function as a
 * batch of one, delete it when the function reports no failure for it, leave it alone otherwise. A function that
 * throws leaves the message too (the invocation failed as a whole).
 */
export function startEventSourceMapping(
  sqs: Pick<SQSClient, 'send'>,
  queueUrl: string,
  invoke: (record: SQSRecord) => Promise<SQSBatchResponse | undefined>,
): { stop(): Promise<void> } {
  let running = true;
  const inflight = new Set<Promise<void>>();
  const run = async (record: SQSRecord) => {
    const result = await invoke(record).catch(() => ({
      batchItemFailures: [{ itemIdentifier: record.messageId }],
    }));
    if ((result?.batchItemFailures ?? []).length === 0)
      // A delivery that outlived its visibility timeout (or the queue, at stop) has a stale receipt handle.
      await sqs
        .send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: record.receiptHandle }))
        .catch(() => undefined);
  };
  const poller = (async () => {
    while (running) {
      const res = await sqs
        .send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        )
        .catch(() => undefined);
      for (const m of res?.Messages ?? []) {
        const p = run({
          messageId: m.MessageId as string,
          receiptHandle: m.ReceiptHandle as string,
          body: m.Body as string,
          attributes: { ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? '1' },
        } as SQSRecord).finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await poller;
      await Promise.allSettled([...inflight]);
    },
  };
}
