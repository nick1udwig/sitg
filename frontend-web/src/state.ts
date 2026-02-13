import type { MeResponse } from './types';

export type NoticeKind = 'success' | 'error' | 'info';

export interface UiNotice {
  kind: NoticeKind;
  message: string;
}

export interface AppState {
  me: MeResponse | null;
  notices: UiNotice[];
  busy: Record<string, boolean>;
}

const state: AppState = {
  me: null,
  notices: [],
  busy: {}
};

function pushNotice(kind: NoticeKind, message: string): void {
  state.notices = [{ kind, message }, ...state.notices].slice(0, 3);
}

export function getState(): AppState {
  return state;
}

export function setMe(me: MeResponse | null): void {
  state.me = me;
}

export function clearNotices(): void {
  state.notices = [];
}

export function dismissNotice(index: number): void {
  state.notices = state.notices.filter((_, i) => i !== index);
}

export function addSuccessNotice(message: string): void {
  pushNotice('success', message);
}

export function addErrorNotice(message: string): void {
  pushNotice('error', message);
}

export function addInfoNotice(message: string): void {
  pushNotice('info', message);
}

export function isBusy(key: string): boolean {
  return Boolean(state.busy[key]);
}

export async function withBusyAction<T>(
  key: string,
  action: () => Promise<T>,
  options?: { successMessage?: string }
): Promise<T | null> {
  if (state.busy[key]) {
    return null;
  }

  state.busy[key] = true;
  try {
    const result = await action();
    if (options?.successMessage) {
      addSuccessNotice(options.successMessage);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected failure';
    addErrorNotice(message);
    return null;
  } finally {
    state.busy[key] = false;
  }
}
