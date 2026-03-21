import { create } from 'zustand';

// ── Types ───────────────────────────────────────────────────────────────────

export interface AuthState {
  isAuthenticated: boolean;
  userName: string;
  orgName: string;
  orgType: 'production' | 'sandbox';
  instanceUrl: string;
}

export interface UiState {
  sidebarCollapsed: boolean;
  darkMode: boolean;
  activeToolId: string | null;
  globalSearchOpen: boolean;
}

export interface CacheEntry {
  data: unknown;
  fetchedAt: Date;
}

export interface ApiLimitsState {
  used: number;
  total: number;
  lastChecked: Date | null;
}

export interface AppState {
  // ── Slices ──────────────────────────────────────────────────────────────
  auth: AuthState;
  ui: UiState;
  cache: Map<string, CacheEntry>;
  apiLimits: ApiLimitsState;

  // ── Auth actions ────────────────────────────────────────────────────────
  setAuth: (auth: AuthState) => void;
  clearAuth: () => void;

  // ── UI actions ──────────────────────────────────────────────────────────
  toggleSidebar: () => void;
  toggleDarkMode: () => void;
  setActiveTool: (toolId: string | null) => void;
  toggleGlobalSearch: () => void;

  // ── Cache actions ───────────────────────────────────────────────────────
  setCacheEntry: (key: string, data: unknown) => void;
  getCacheEntry: (key: string) => CacheEntry | undefined;

  // ── API limits actions ──────────────────────────────────────────────────
  setApiLimits: (limits: { used: number; total: number }) => void;
}

// ── Default values ──────────────────────────────────────────────────────────

const defaultAuth: AuthState = {
  isAuthenticated: false,
  userName: '',
  orgName: '',
  orgType: 'production',
  instanceUrl: '',
};

const defaultUi: UiState = {
  sidebarCollapsed: false,
  darkMode: false,
  activeToolId: null,
  globalSearchOpen: false,
};

const defaultApiLimits: ApiLimitsState = {
  used: 0,
  total: 0,
  lastChecked: null,
};

// ── Store ───────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>((set, get) => ({
  // ── Initial state ─────────────────────────────────────────────────────
  auth: defaultAuth,
  ui: defaultUi,
  cache: new Map<string, CacheEntry>(),
  apiLimits: defaultApiLimits,

  // ── Auth actions ──────────────────────────────────────────────────────
  setAuth: (auth) => set({ auth }),

  clearAuth: () => set({ auth: defaultAuth }),

  // ── UI actions ────────────────────────────────────────────────────────
  toggleSidebar: () =>
    set((state) => ({
      ui: { ...state.ui, sidebarCollapsed: !state.ui.sidebarCollapsed },
    })),

  toggleDarkMode: () =>
    set((state) => ({
      ui: { ...state.ui, darkMode: !state.ui.darkMode },
    })),

  setActiveTool: (toolId) =>
    set((state) => ({
      ui: { ...state.ui, activeToolId: toolId },
    })),

  toggleGlobalSearch: () =>
    set((state) => ({
      ui: { ...state.ui, globalSearchOpen: !state.ui.globalSearchOpen },
    })),

  // ── Cache actions ─────────────────────────────────────────────────────
  setCacheEntry: (key, data) =>
    set((state) => {
      const nextCache = new Map(state.cache);
      nextCache.set(key, { data, fetchedAt: new Date() });
      return { cache: nextCache };
    }),

  getCacheEntry: (key) => get().cache.get(key),

  // ── API limits actions ────────────────────────────────────────────────
  setApiLimits: ({ used, total }) =>
    set({
      apiLimits: { used, total, lastChecked: new Date() },
    }),
}));
