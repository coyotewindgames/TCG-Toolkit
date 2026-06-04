/**
 * One-off: set or reset the password on an existing user. Used for seeding a
 * known login on a dev environment (and as an emergency reset tool).
 *
 * Usage:
 *   $env:USER_EMAIL="me@example.com"
 *   $env:USER_PASSWORD="something-strong"
 *   npm run set:password -w @tcg/api
 *
 * Looks up the user by lowercased email and writes the bcryptjs hash. Fails
 * loudly if the user doesn't exist — this script is intentionally not a
 * create-or-update.
 */
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '../db/client';
import { hashPassword } from '../server/auth/service';

async function main() {
  const email = process.env.USER_EMAIL?.trim().toLowerCase();
  const password = process.env.USER_PASSWORD;
  if (!email || !password) {
    console.error('USER_EMAIL and USER_PASSWORD env vars are required.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('USER_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const db = getDb();
  const existing = await db
    .select({ id: schema.users.id, storeId: schema.users.storeId, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existing.length === 0) {
    console.error(`No user found with email ${email}.`);
    await getPool().end();
    process.exit(1);
  }

  const user = existing[0];
  const passwordHash = await hashPassword(password);
  await db
    .update(schema.users)
    .set({ passwordHash })
    .where(eq(schema.users.id, user.id));

  console.log(`Password set for ${email}: id=${user.id} storeId=${user.storeId} role=${user.role}`);
  await getPool().end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await getPool().end();
  } catch {
    // ignore
  }
  process.exit(1);
});
