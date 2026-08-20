let initialization: Promise<void> = Promise.resolve();

/**
 * Registers the background boot promise after synchronous MV3 listener
 * registration. Runtime messages can then wait for migrations to finish
 * without delaying listener registration and losing the wake-up event.
 */
export function setBackgroundInitialization(promise: Promise<void>): void {
  initialization = promise;
}

/** Wait until storage migrations and bridge bootstrap have reached a stable state. */
export function waitForBackgroundInitialization(): Promise<void> {
  return initialization;
}
