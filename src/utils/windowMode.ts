/* src/utils/windowMode.ts */

/**
 * Detached webview windows are opened with a query string of the form
 * `?detached=<mode>&taskId=<id>`. These helpers let both the store (to skip
 * side-effecting singletons like the scheduler) and the UI (to render the
 * detached layout) reason about the current window without prop drilling.
 */

export type DetachedMode = 'progress';

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** The detached mode of this window, or null for the primary window. */
export function detachedMode(): DetachedMode | null {
  const value = params().get('detached');
  return value === 'progress' ? value : null;
}

/** True when this window is any kind of detached companion window. */
export function isDetachedWindow(): boolean {
  return detachedMode() !== null;
}

/** The task id a detached progress window is bound to, if any. */
export function detachedTaskId(): string | null {
  return params().get('taskId');
}
