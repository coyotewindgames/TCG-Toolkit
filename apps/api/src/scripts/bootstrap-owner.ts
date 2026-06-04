/**
 * One-shot bootstrap: creates a store + default location + owner user so you
 * can log in and use the Settings page. Calls the same onboarding service
 * that the public `POST /auth/signup` endpoint uses, so behavior stays in
 * sync.
 *
 * Usage:
 *   $env:STORE_NAME="My Card Shop"
 *   $env:OWNER_EMAIL="me@example.com"
 *   $env:OWNER_PASSWORD="something-strong"
 *   $env:OWNER_NAME="Brett"
 *   npm run bootstrap:owner -w @tcg/api
 *
 * Idempotent on email: if a user with that email already exists in any store
 * we just print the existing IDs and exit cleanly.
 */
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '../db/client';
import { createStoreWithOwner } from '../server/services/onboarding-service';

async function main() {
  const storeName = process.env.STORE_NAME ?? 'My Store';
  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  const displayName = process.env.OWNER_NAME ?? 'Owner';
  const timezone = process.env.STORE_TIMEZONE;

  if (!email || !password) {
    console.error('OWNER_EMAIL and OWNER_PASSWORD env vars are required.');
    process.exit(1);
  }

  const db = getDb();

  const existing = await db
    .select({ id: schema.users.id, storeId: schema.users.storeId, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()));

  if (existing.length > 0) {
    const u = existing[0];
    console.log(`User already exists: id=${u.id} storeId=${u.storeId} role=${u.role}`);
    await getPool().end();
    return;
  }

  const created = await createStoreWithOwner(db, {
    storeName,
    ownerEmail: email,
    ownerPassword: password,
    ownerName: displayName,
    timezone,
  });

  console.log('Created store:', created.store);
  console.log('Created location:', created.location);
  console.log('Created owner:', {
    id: created.owner.id,
    email: created.owner.email,
    role: created.owner.role,
  });
  console.log('\nLog in with:');
  console.log(`  POST /api/auth/login  { "email": "${email}", "password": "<your password>" }`);

  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
