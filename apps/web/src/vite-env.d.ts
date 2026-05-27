/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_LOCATION_ID: string;
  readonly VITE_REGISTER_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
