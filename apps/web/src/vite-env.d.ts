/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API; empty string when same-origin via Vite proxy. */
  readonly VITE_API_URL?: string;
  /** Optional Sentry DSN for the SPA. */
  readonly VITE_SENTRY_DSN?: string;
  /**
   * Dev-only escape hatch. JSON-encoded `{ id, storeId, role, email,
   * displayName }` that pre-seeds the session without a real login. Ignored
   * in production. Replaces the legacy VITE_DEV_USER_ID / VITE_DEV_STORE_ID /
   * VITE_DEV_ROLE / VITE_DEV_EMAIL constellation.
   */
  readonly VITE_DEV_USER?: string;
  /** Optional Clover device id used by the demo register page. */
  readonly VITE_CLOVER_DEVICE_ID?: string;
  /** Optional public web base URL used for remote scanner QR links. */
  readonly VITE_REMOTE_SCAN_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
