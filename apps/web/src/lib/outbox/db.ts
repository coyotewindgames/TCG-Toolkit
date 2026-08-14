/**
 * IndexedDB-backed offline outbox for queuing scanned-item-add requests
 * when the network is unavailable.
 */
import { openDB, type IDBPDatabase } from 'idb';

export type OutboxStatus = 'pending' | 'in_flight' | 'failed';

export interface OutboxEntry {
  clientRequestId: string;
  orderId: string;
  action: 'add_item';
  payload: { barcode: string; clientRequestId: string };
  status: OutboxStatus;
  attempts: number;
  createdAt: number;
  lastError?: string;
}

const DB_NAME = 'tcg-outbox';
const DB_VERSION = 1;
const STORE_NAME = 'entries';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'clientRequestId' });
        }
      },
    });
  }
  return dbPromise;
}

export async function enqueue(entry: OutboxEntry): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, entry);
}

export async function getAllPending(): Promise<OutboxEntry[]> {
  const db = await getDb();
  const all = await db.getAll(STORE_NAME);
  return (all as OutboxEntry[]).filter((e) => e.status === 'pending' || e.status === 'failed');
}

export async function getByOrderId(orderId: string): Promise<OutboxEntry[]> {
  const db = await getDb();
  const all = await db.getAll(STORE_NAME);
  return (all as OutboxEntry[]).filter((e) => e.orderId === orderId);
}

export async function updateEntry(
  clientRequestId: string,
  updates: Partial<Pick<OutboxEntry, 'status' | 'attempts' | 'lastError'>>,
): Promise<void> {
  const db = await getDb();
  const entry = (await db.get(STORE_NAME, clientRequestId)) as OutboxEntry | undefined;
  if (!entry) return;
  Object.assign(entry, updates);
  await db.put(STORE_NAME, entry);
}

export async function removeEntry(clientRequestId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, clientRequestId);
}
