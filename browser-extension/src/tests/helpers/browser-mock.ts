// Minimal in-memory webextension-polyfill stand-in for unit tests that import
// background/bridge modules. Only the surface those modules touch is implemented.
export type BrowserMock = ReturnType<typeof createBrowserMock>;

export function createBrowserMock(options: { extensionId?: string; sendNativeMessage?: () => Promise<unknown> } = {}) {
  const extensionId = options.extensionId ?? 'testextid';
  const store = new Map<string, unknown>();
  let messageListener: ((msg: unknown, sender: unknown) => unknown) | undefined;

  const sendNativeMessage = options.sendNativeMessage ?? (() => Promise.reject(new Error('native host missing')));

  const browser = {
    runtime: {
      onMessage: { addListener: (fn: (msg: unknown, sender: unknown) => unknown) => { messageListener = fn; } },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (path: string) => `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`,
      getManifest: () => ({ name: 'NOVA Extension', version: '0.0.0', manifest_version: 3 }),
      openOptionsPage: () => Promise.resolve(),
      sendNativeMessage: () => sendNativeMessage(),
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.get(key) }),
        set: (entries: Record<string, unknown>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); return Promise.resolve(); },
        remove: (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); return Promise.resolve(); },
      },
    },
    tabs: {
      create: () => Promise.resolve({ id: 1 }),
      query: () => Promise.resolve([{ id: 1, active: true }]),
      sendMessage: () => Promise.resolve(undefined),
    },
    action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    permissions: { contains: () => Promise.resolve(true) },
  };

  return {
    browser,
    extensionId,
    store,
    uiSenderUrl: `chrome-extension://${extensionId}/popup.html`,
    invokeMessage: (msg: unknown, sender: unknown) => {
      if (!messageListener) throw new Error('no runtime.onMessage listener registered');
      return messageListener(msg, sender);
    },
  };
}
