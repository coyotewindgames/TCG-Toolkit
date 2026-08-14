/**
 * Outbox flush processor: retries queued offline requests with exponential
 * backoff. Triggered on `online` events and a periodic timer.
 */
import { api } from '../api';
import { enqueue, getAllPending, removeEntry, updateEntry, type OutboxEntry } from './db';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const POLL_INTERVAL_MS = 15_000;

type FlushListener = () => void;
const listeners: Set<FlushListener> = new Set();

/** Register a callback invoked after any outbox entry is successfully flushed. */
export function onFlushed(cb: FlushListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notifyListeners() {
  for (const cb of listeners) {
    try { cb(); } catch { /* best-effort */ }
  }
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && /fetch|network/i.test(err.message)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /networkerror|failed to fetch|load failed/i.test(msg);
}

async function flushOne(entry: OutboxEntry): Promise<void> {
  await updateEntry(entry.clientRequestId, { status: 'in_flight' });
  try {
    await api.post(`/orders/${entry.orderId}/items`, entry.payload);
    await removeEntry(entry.clientRequestId);
    notifyListeners();
  } catch (err) {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await updateEntry(entry.clientRequestId, {
        status: 'failed',
        attempts,
        lastError: err instanceof Error ? err.message : String(err),
      });
    } else {
      await updateEntry(entry.clientRequestId, {
        status: 'pending',
        attempts,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function flushAll(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const entries = await getAllPending();
  for (const entry of entries) {
    const delay = BASE_DELAY_MS * Math.pow(2, entry.attempts);
    const elapsed = Date.now() - entry.createdAt;
    if (entry.attempts > 0 && elapsed < delay) continue;
    await flushOne(entry);
  }
}

/** Retry a specific failed entry (manual retry affordance). */
export async function retryEntry(clientRequestId: string): Promise<void> {
  await updateEntry(clientRequestId, { status: 'pending', attempts: 0, lastError: undefined });
  await flushAll();
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startProcessor(): void {
  if (intervalId) return;
  // Flush immediately, then on a timer.
  void flushAll();
  intervalId = setInterval(() => void flushAll(), POLL_INTERVAL_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void flushAll());
  }
}

export function stopProcessor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Attempt a network call; on a network-level failure, enqueue into the outbox.
 * Returns the API response on success, or null if queued offline.
 */
export async function postWithOutbox<T>(args: {
  orderId: string;
  barcode: string;
  clientRequestId: string;
}): Promise<T | null> {
  const payload = { barcode: args.barcode, clientRequestId: args.clientRequestId };
  try {
    return await api.post<T>(`/orders/${args.orderId}/items`, payload);
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueue({
        clientRequestId: args.clientRequestId,
        orderId: args.orderId,
        action: 'add_item',
        payload,
        status: 'pending',
        attempts: 0,
        createdAt: Date.now(),
      });
      return null;
    }
    throw err;
  }
}

export { getAllPending, getByOrderId } from './db';
