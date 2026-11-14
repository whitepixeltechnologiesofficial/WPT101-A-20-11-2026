/**
 * WEB-R1.5: background store for relayed envelopes.
 *
 * Fed silently by the session channel: live pushes, the reconnect drain,
 * and a /relay/poll after `queue_more`. Deduped by id because a message
 * can arrive both live and in a drain. Nothing here renders, logs, or
 * exposes a "syncing" state; the chat list (WEB-2.1) subscribes and simply
 * shows whatever is present.
 */

import type { RelayMessage } from "@wpt/shared";

const messages = new Map<string, RelayMessage>();
const listeners = new Set<() => void>();

export function addMessages(batch: readonly RelayMessage[]): number {
  let added = 0;
  for (const m of batch) {
    if (!messages.has(m.id)) {
      messages.set(m.id, m);
      added++;
    }
  }
  if (added) listeners.forEach((l) => l());
  return added;
}

export function getMessages(): RelayMessage[] {
  return [...messages.values()];
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop everything (log-off / forced logout): nothing outlives the session. */
export function clearInbox(): void {
  messages.clear();
  listeners.forEach((l) => l());
}
