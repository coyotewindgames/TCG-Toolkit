import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseEnabled = Boolean(
  config.apiKey && config.authDomain && config.projectId && config.appId,
);

const app = firebaseEnabled
  ? (getApps().length ? getApp() : initializeApp(config))
  : null;

export const firebaseAuth = app ? getAuth(app) : null;
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export function requireFirebaseAuth() {
  if (!firebaseAuth) {
    throw new Error('Firebase Authentication is not configured for this application.');
  }
  return firebaseAuth;
}

export async function waitForFirebaseUser(): Promise<User | null> {
  const auth = firebaseAuth;
  if (!auth) return null;
  await auth.authStateReady();
  return auth.currentUser;
}

export async function getFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  const user = firebaseAuth?.currentUser;
  return user ? user.getIdToken(forceRefresh) : null;
}

export async function signInWithFirebaseEmail(email: string, password: string): Promise<User> {
  const result = await signInWithEmailAndPassword(requireFirebaseAuth(), email, password);
  return result.user;
}

export async function signInWithFirebaseGoogle(): Promise<User> {
  const result = await signInWithPopup(requireFirebaseAuth(), googleProvider);
  return result.user;
}

export async function createFirebaseOwner(
  email: string,
  password: string,
  displayName: string,
): Promise<User> {
  const auth = requireFirebaseAuth();
  let result;
  try {
    result = await createUserWithEmailAndPassword(auth, email, password);
  } catch (error) {
    // A previous provisioning request may have committed before its response
    // reached the browser. Re-authenticate so the idempotent API call can be
    // retried instead of creating an orphaned second identity.
    if ((error as { code?: string }).code !== 'auth/email-already-in-use') throw error;
    result = await signInWithEmailAndPassword(auth, email, password);
  }
  await updateProfile(result.user, { displayName });
  return result.user;
}

export async function requestFirebasePasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(requireFirebaseAuth(), email);
}

export async function signOutFirebase(): Promise<void> {
  if (firebaseAuth) await signOut(firebaseAuth);
}

export function observeFirebaseTokens(listener: (user: User | null) => void): () => void {
  if (!firebaseAuth) return () => undefined;
  return onAuthStateChanged(firebaseAuth, listener);
}
