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
