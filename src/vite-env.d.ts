/// <reference types="vite/client" />

interface TauriInvokeFn {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface FileWithPath extends File {
  path?: string;
}

interface Window {
  __TAURI_INTERNALS__?: TauriInvokeFn;
}

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_NOVA_API_URL?: string;
  readonly VITE_NOVA_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
