import type { Store } from './store.ts';

/** Only a matching native RPC rejection proves that no task was accepted. */
export class DeliveryNotAcceptedError extends Error {}

export async function sendDelivery(store: Store, id: string, mode: 'sent' | 'staged', send: () => void | Promise<void>) {
  const attempt = store.beginDelivery(id, mode);
  try {
    await send();
    return store.finishDelivery(id, attempt.id, mode);
  } catch (error) {
    const rejected = error instanceof DeliveryNotAcceptedError;
    store.finishDelivery(id, attempt.id, rejected ? 'rejected' : 'unknown', error instanceof Error ? error.message : '投递结果无法确认');
    if (rejected) throw error;
    throw new Error('投递结果待确认：原生会话可能已经收到消息。请进入核对后确认结果，避免重复发送。');
  }
}
