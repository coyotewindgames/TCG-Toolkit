import { eq, gt, and } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { hashPassword } from '../auth/service';
import { BadRequest, Conflict } from '../../common/http-errors';
import type { AuthenticatedUser } from '../auth/types';

function isMissingOnboardingColumnError(err: unknown): boolean {
  const maybe = err as {
    message?: string;
    code?: string;
    cause?: { message?: string; code?: string };
  };
  const msg = `${maybe?.message ?? ''} ${maybe?.cause?.message ?? ''}`.toLowerCase();
  const code = maybe?.code ?? maybe?.cause?.code;
  return code === '42703' && msg.includes('onboarding_completed_at');
}

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

export interface OnboardingStatus {
  storeCreated: true;
  tcgapiConfigured: boolean;
  inventoryImported: boolean;
  posConfigured: boolean;
  completedAt: Date | null;
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

/**
 * Returns the current onboarding progress for a store.
 * Used by both the wizard and the sidebar checklist.
 */
export async function getOnboardingStatus(
  db: Database,
  storeId: string,
): Promise<OnboardingStatus> {
  let storeCompletedAt: Date | null = null;
  try {
    const [storeRow] = await db
      .select({ onboardingCompletedAt: schema.stores.onboardingCompletedAt })
      .from(schema.stores)
      .where(eq(schema.stores.id, storeId))
      .limit(1);
    storeCompletedAt = storeRow?.onboardingCompletedAt ?? null;
  } catch (err) {
    if (!isMissingOnboardingColumnError(err)) {
      throw err;
    }
    console.warn(
      '[onboarding] stores.onboarding_completed_at missing; returning completedAt=null. Run migration 0006_onboarding.sql.',
      { storeId },
    );
  }

  const [tcgapiRow] = await db
    .select({ id: schema.tcgapiConfigs.storeId })
    .from(schema.tcgapiConfigs)
    .where(eq(schema.tcgapiConfigs.storeId, storeId))
    .limit(1);

  const [posRow] = await db
    .select({ id: schema.posConfigs.storeId })
    .from(schema.posConfigs)
    .where(eq(schema.posConfigs.storeId, storeId))
    .limit(1);

  // Inventory is imported if any location under this store has qty_on_hand > 0.
  const [invRow] = await db
    .select({ skuId: schema.inventory.skuId })
    .from(schema.inventory)
    .innerJoin(schema.locations, eq(schema.inventory.locationId, schema.locations.id))
    .where(
      and(
        eq(schema.locations.storeId, storeId),
        gt(schema.inventory.qtyOnHand, 0),
      ),
    )
    .limit(1);

  return {
    storeCreated: true,
    tcgapiConfigured: !!tcgapiRow,
    inventoryImported: !!invRow,
    posConfigured: !!posRow,
    completedAt: storeCompletedAt,
  };
}

/**
 * Marks the onboarding wizard as complete for the given store.
 * Idempotent — safe to call even if already marked complete.
 */
export async function completeOnboarding(db: Database, storeId: string): Promise<void> {
  try {
    await db
      .update(schema.stores)
      .set({ onboardingCompletedAt: new Date() })
      .where(eq(schema.stores.id, storeId));
  } catch (err) {
    if (!isMissingOnboardingColumnError(err)) {
      throw err;
    }
    console.warn(
      '[onboarding] cannot persist completion because stores.onboarding_completed_at is missing. Run migration 0006_onboarding.sql.',
      { storeId },
    );
  }
}
