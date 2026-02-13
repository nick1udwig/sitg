import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { MeResponse } from './types';

export interface RepoSelection {
  id: string;
  fullName: string;
}

interface Notice {
  type: 'success' | 'error' | 'info';
  message: string;
}

interface AppState {
  me: MeResponse | null;
  selectedRepo: RepoSelection | null;
  recentRepos: RepoSelection[];
  busy: Record<string, boolean>;
  notices: Notice[];
}

type Action =
  | { type: 'set_me'; payload: MeResponse | null }
  | { type: 'set_repo'; payload: RepoSelection }
  | { type: 'set_busy'; key: string; value: boolean }
  | { type: 'add_notice'; payload: Notice }
  | { type: 'dismiss_notice'; index: number }
  | { type: 'clear_notices' };

const RECENT_REPOS_KEY = 'stc.recentRepos';
const SELECTED_REPO_KEY = 'stc.selectedRepo';

function loadLocalRepos(): RepoSelection[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as RepoSelection[];
    return parsed.filter((v) => v.id && v.fullName).slice(0, 8);
  } catch {
    return [];
  }
}

function loadSelectedRepo(recentRepos: RepoSelection[]): RepoSelection | null {
  try {
    const raw = localStorage.getItem(SELECTED_REPO_KEY);
    if (!raw) {
      return recentRepos[0] ?? null;
    }

    const parsed = JSON.parse(raw) as RepoSelection;
    if (!parsed.id || !parsed.fullName) {
      return recentRepos[0] ?? null;
    }

    return parsed;
  } catch {
    return recentRepos[0] ?? null;
  }
}

const initialRecent = loadLocalRepos();

const initialState: AppState = {
  me: null,
  selectedRepo: loadSelectedRepo(initialRecent),
  recentRepos: initialRecent,
  busy: {},
  notices: []
};

function persistRepos(repos: RepoSelection[], selected: RepoSelection): void {
  localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(repos));
  localStorage.setItem(SELECTED_REPO_KEY, JSON.stringify(selected));
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'set_me':
      return { ...state, me: action.payload };
    case 'set_repo': {
      const without = state.recentRepos.filter((repo) => repo.id !== action.payload.id);
      const nextRecent = [action.payload, ...without].slice(0, 8);
      persistRepos(nextRecent, action.payload);
      return { ...state, selectedRepo: action.payload, recentRepos: nextRecent };
    }
    case 'set_busy':
      return { ...state, busy: { ...state.busy, [action.key]: action.value } };
    case 'add_notice':
      return { ...state, notices: [action.payload, ...state.notices].slice(0, 4) };
    case 'dismiss_notice':
      return { ...state, notices: state.notices.filter((_, idx) => idx !== action.index) };
    case 'clear_notices':
      return { ...state, notices: [] };
    default:
      return state;
  }
}

interface AppStateValue {
  state: AppState;
  setMe: (me: MeResponse | null) => void;
  setRepo: (repo: RepoSelection) => void;
  isBusy: (key: string) => boolean;
  runBusy: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
  pushNotice: (type: Notice['type'], message: string) => void;
  dismissNotice: (index: number) => void;
  clearNotices: () => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setMe = useCallback((me: MeResponse | null) => {
    dispatch({ type: 'set_me', payload: me });
  }, []);

  const setRepo = useCallback((repo: RepoSelection) => {
    dispatch({ type: 'set_repo', payload: repo });
  }, []);

  const pushNotice = useCallback((type: Notice['type'], message: string) => {
    dispatch({ type: 'add_notice', payload: { type, message } });
  }, []);

  const dismissNotice = useCallback((index: number) => {
    dispatch({ type: 'dismiss_notice', index });
  }, []);

  const clearNotices = useCallback(() => {
    dispatch({ type: 'clear_notices' });
  }, []);

  const isBusy = useCallback((key: string) => Boolean(state.busy[key]), [state.busy]);

  const runBusy = useCallback(
    async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
      if (state.busy[key]) {
        return null;
      }

      dispatch({ type: 'set_busy', key, value: true });
      try {
        return await fn();
      } finally {
        dispatch({ type: 'set_busy', key, value: false });
      }
    },
    [state.busy]
  );

  const value = useMemo<AppStateValue>(() => {
    return {
      state,
      setMe,
      setRepo,
      isBusy,
      runBusy,
      pushNotice,
      dismissNotice,
      clearNotices
    };
  }, [clearNotices, dismissNotice, isBusy, pushNotice, runBusy, setMe, setRepo, state]);

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) {
    throw new Error('useAppState must be used inside AppStateProvider');
  }
  return value;
}
