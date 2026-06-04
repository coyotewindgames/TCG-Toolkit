import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { hashPassword } from '../auth/service';
import { BadRequest, Conflict } from '../../common/http-errors';
import type { AuthenticatedUser } from '../auth/types';

export interface CreateStoreInput {
  storeName: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerName: string;
  /** IANA timezone identifier; defaults to America/New_York. */
  timezone?: string;
  /** Name of the default location created alongside the store. */
  locationName?: string;
}

export interface CreatedStore {
  store: { id: string; name: string };
  location: { id: string; name: string };
  owner: AuthenticatedUser;
}

/**
 * Creates a new tenant: a `stores` row, a default `locations` row, and an
 * owner `users` row, all in a single transaction. Used by both the public
 * signup endpoint and the CLI bootstrap script so onboarding logic lives in
 * exactly one place.
 *
 * **Email policy:** rejects with 409 if any other store already has a user
 * with the same email. The schema permits `(store_id, email)` uniqueness,
 * which means the same email could exist in multiple stores — but allowing
 * that without a "which shop?" picker at login is a cross-tenant data-leak
 * risk. v1 enforces globally-unique owner emails; once we add a multi-store
 * login picker we can relax this for staff invites.
 */
export async function createStoreWithOwner(
  db: Database,
  input: CreateStoreInput,
): Promise<CreatedStore> {
  const email = input.ownerEmail.trim().toLowerCase();
  if (!email) throw BadRequest('email required');
  if (input.ownerPassword.length < 8) throw BadRequest('password must be at least 8 characters');
  if (!input.storeName.trim()) throw BadRequest('storeName required');
  if (!input.ownerName.trim()) throw BadRequest('ownerName required');

  // Pre-flight check (still racy with a parallel signup — the transaction
  // below repeats the same check inside the tx so we never persist a
  // duplicate).
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing.length > 0) throw Conflict('an account with that email already exists');

  const passwordHash = await hashPassword(input.ownerPassword);

  return db.transaction(async (tx) => {
    const dupe = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (dupe.length > 0) throw Conflict('an account with that email already exists');

    const [store] = await tx
      .insert(schema.stores)
      .values({
        name: input.storeName.trim(),
        timezone: input.timezone ?? 'America/New_York',
      })
      .returning({ id: schema.stores.id, name: schema.stores.name });

    const [location] = await tx
      .insert(schema.locations)
      .values({
        storeId: store.id,
        name: input.locationName?.trim() || 'Main',
      })
      .returning({ id: schema.locations.id, name: schema.locations.name });

    const [user] = await tx
      .insert(schema.users)
      .values({
        storeId: store.id,
        email,
        displayName: input.ownerName.trim(),
        role: 'owner',
        passwordHash,
      })
      .returning({
        id: schema.users.id,
        storeId: schema.users.storeId,
        email: schema.users.email,
        displayName: schema.users.displayName,
        role: schema.users.role,
      });

    return {
      store,
      location,
      owner: {
        id: user.id,
        storeId: user.storeId,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    };
  });
}
