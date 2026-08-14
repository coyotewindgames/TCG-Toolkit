/**
 * Import legacy bcrypt users into Firebase Authentication and reconcile the
 * external UID mapping. Dry-run is the default; pass --apply to mutate
 * Firebase and Postgres after taking a database snapshot.
 */
import type { Auth, UserImportRecord } from 'firebase-admin/auth';
import { eq } from 'drizzle-orm';
import { getDb, getPool, schema } from '../db/client';
import { getFirebaseAuth } from '../server/auth/firebase-admin';

const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = 1000;

type LegacyUser = typeof schema.users.$inferSelect;

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findFirebaseUidByEmail(auth: Auth, email: string): Promise<string | null> {
  try {
    return (await auth.getUserByEmail(email)).uid;
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') return null;
    throw error;
  }
}

async function existingFirebaseEmail(auth: Auth, uid: string): Promise<string | null> {
  try {
    return normalizedEmail((await auth.getUser(uid)).email ?? '');
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/user-not-found') return null;
    throw error;
  }
}

function validateUsers(users: LegacyUser[]): void {
  if (!users.length) throw new Error('No users found; refusing to run an empty migration');

  const seenEmails = new Map<string, string>();
  for (const user of users) {
    const email = normalizedEmail(user.email);
    if (!email) throw new Error(`User ${user.id} has no usable email`);
    if (!user.passwordHash) throw new Error(`User ${user.id} has no bcrypt password hash`);
    if (!/^\$2[aby]\$/.test(user.passwordHash)) {
      throw new Error(`User ${user.id} does not have a recognized bcrypt password hash`);
    }
    const duplicate = seenEmails.get(email);
    if (duplicate && duplicate !== user.id) {
      throw new Error(`Duplicate normalized email detected for users ${duplicate} and ${user.id}`);
    }
    seenEmails.set(email, user.id);
  }
}

async function preflight(auth: Auth, users: LegacyUser[]) {
  const pending: LegacyUser[] = [];
  const alreadyPresent: LegacyUser[] = [];

  for (const user of users) {
    const email = normalizedEmail(user.email);
    const existingEmail = await existingFirebaseEmail(auth, user.id);
    if (existingEmail !== null) {
      if (existingEmail !== email) {
        throw new Error(`Firebase UID collision for app user ${user.id}`);
      }
      alreadyPresent.push(user);
      continue;
    }

    const uidForEmail = await findFirebaseUidByEmail(auth, email);
    if (uidForEmail && uidForEmail !== user.id) {
      throw new Error(`Firebase email collision for app user ${user.id}`);
    }
    pending.push(user);
  }

  return { pending, alreadyPresent };
}

function toImportRecord(user: LegacyUser): UserImportRecord {
  return {
    uid: user.id,
    email: normalizedEmail(user.email),
    displayName: user.displayName,
    disabled: Boolean(user.disabledAt),
    passwordHash: Buffer.from(user.passwordHash!, 'utf8'),
  };
}

async function mapFirebaseUid(user: LegacyUser): Promise<void> {
  if (user.firebaseUid && user.firebaseUid !== user.id) {
    throw new Error(`User ${user.id} is already mapped to a different Firebase UID`);
  }
  await getDb()
    .update(schema.users)
    .set({ firebaseUid: user.id })
    .where(eq(schema.users.id, user.id));
}

async function main(): Promise<void> {
  const auth = getFirebaseAuth();
  if (!auth) throw new Error('Firebase Admin is not configured');

  const users = await getDb().select().from(schema.users);
  validateUsers(users);
  const { pending, alreadyPresent } = await preflight(auth, users);

  console.info(
    JSON.stringify({
      mode: APPLY ? 'apply' : 'dry-run',
      total: users.length,
      pending: pending.length,
      alreadyPresent: alreadyPresent.length,
    }),
  );

  if (!APPLY) {
    console.info('Dry run complete. Re-run with --apply only after taking a database snapshot.');
    return;
  }

  for (const user of alreadyPresent) await mapFirebaseUid(user);

  for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
    const batch = pending.slice(offset, offset + BATCH_SIZE);
    const result = await auth.importUsers(batch.map(toImportRecord), {
      hash: { algorithm: 'BCRYPT' },
    });
    const failedIndexes = new Set(result.errors.map(({ index }) => index));

    for (let index = 0; index < batch.length; index += 1) {
      if (!failedIndexes.has(index)) await mapFirebaseUid(batch[index]!);
    }

    if (result.failureCount) {
      const failures = result.errors.map(({ index, error }) => ({
        userId: batch[index]?.id,
        code: error.code,
      }));
      console.error(JSON.stringify({ failures }));
      throw new Error(`Firebase import failed for ${result.failureCount} user(s)`);
    }
  }

  console.info(JSON.stringify({ imported: pending.length, reconciled: users.length }));
}

main()
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });