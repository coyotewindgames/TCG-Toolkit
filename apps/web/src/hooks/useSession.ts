import { useSyncExternalStore } from 'react';
import { getSession, subscribeSession, type SessionState } from '../lib/session';

/** Subscribes to the global session and returns the current snapshot. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}
