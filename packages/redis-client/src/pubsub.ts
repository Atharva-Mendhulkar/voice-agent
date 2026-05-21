import { Redis } from 'ioredis';
import { WorkflowResultEvent } from '@voice-agent/shared-types';

export class WorkflowResultBroker {
  private publisher: Redis;
  private subscriber: Redis;

  constructor(publisher: Redis, subscriber: Redis) {
    this.publisher = publisher;
    this.subscriber = subscriber;
  }

  async publishResult(roomId: string, event: WorkflowResultEvent): Promise<void> {
    const channel = `workflow:result:${roomId}`;
    await this.publisher.publish(channel, JSON.stringify(event));
  }

  subscribeToResults(
    roomId: string,
    handler: (event: WorkflowResultEvent) => void
  ): () => void {
    const channel = `workflow:result:${roomId}`;

    const onMessage = (chan: string, message: string) => {
      if (chan === channel) {
        try {
          const parsed = JSON.parse(message) as WorkflowResultEvent;
          handler(parsed);
        } catch (err) {
          console.error(`Failed to parse workflow result event on channel ${channel}:`, err);
        }
      }
    };

    this.subscriber.subscribe(channel);
    this.subscriber.on('message', onMessage);

    return () => {
      (this.subscriber as any).off('message', onMessage);
      this.subscriber.unsubscribe(channel).catch((err) => {
        console.error(`Error unsubscribing from channel ${channel}:`, err);
      });
    };
  }
}
