/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the same-origin `/trpc` default. Normally left unset. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
