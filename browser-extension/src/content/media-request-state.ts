export type MediaRequestState = {
  nextId: number;
  activeId: number | null;
};

export function createMediaRequestState(): MediaRequestState {
  return { nextId: 0, activeId: null };
}

export function beginMediaRequest(state: MediaRequestState): number {
  state.nextId += 1;
  state.activeId = state.nextId;
  return state.nextId;
}

export function invalidateMediaRequest(state: MediaRequestState): void {
  state.nextId += 1;
  state.activeId = null;
}

export function isCurrentMediaRequest(state: MediaRequestState, requestId: number): boolean {
  return state.activeId === requestId;
}

export function finishMediaRequest(state: MediaRequestState, requestId: number): void {
  if (state.activeId === requestId) state.activeId = null;
}
