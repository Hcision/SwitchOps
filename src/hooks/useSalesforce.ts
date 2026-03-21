import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/services/store';
import type { AuthState, CacheEntry } from '@/services/store';
import type {
  SalesforceRecord,
  SalesforceQueryResult,
} from '@/services/salesforce';
import {
  initiateLogin,
  handleCallback,
  logout as sfLogout,
  query as sfQuery,
  toolingQuery as sfToolingQuery,
  getApiLimits as sfGetApiLimits,
  isAuthenticated as sfIsAuthenticated,
} from '@/services/salesforce';

// ── Types ───────────────────────────────────────────────────────────────────

interface QueryOptions {
  cacheKey?: string;
  enabled?: boolean;
}

interface QueryResult<T = unknown> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  lastFetchedAt: Date | null;
}

interface AuthHook {
  auth: AuthState;
  login: (isSandbox?: boolean) => Promise<void>;
  logout: () => void;
  handleOAuthCallback: () => Promise<void>;
  loginLoading: boolean;
  loginError: Error | null;
}

interface ApiLimitsHook {
  used: number;
  total: number;
  lastChecked: Date | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

// ── useAuth ─────────────────────────────────────────────────────────────────

export function useAuth(): AuthHook {
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  const clearAuth = useAppStore((s) => s.clearAuth);

  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<Error | null>(null);

  const login = useCallback(
    async (isSandbox = false) => {
      setLoginLoading(true);
      setLoginError(null);
      try {
        await initiateLogin(isSandbox);
        // Browser will redirect; loading stays true until the page unloads.
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setLoginError(error);
        setLoginLoading(false);
        throw error;
      }
    },
    [],
  );

  const handleOAuthCallback = useCallback(async () => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const tokenResponse = await handleCallback();
      setAuth({
        isAuthenticated: true,
        userName: '', // populated later via identity request
        orgName: '',
        orgType: tokenResponse.instance_url.includes('test.salesforce.com')
          ? 'sandbox'
          : 'production',
        instanceUrl: tokenResponse.instance_url,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setLoginError(error);
      throw error;
    } finally {
      setLoginLoading(false);
    }
  }, [setAuth]);

  const logout = useCallback(() => {
    sfLogout();
    clearAuth();
  }, [clearAuth]);

  return { auth, login, logout, handleOAuthCallback, loginLoading, loginError };
}

// ── useSoql ─────────────────────────────────────────────────────────────────

export function useSoql<T extends SalesforceRecord = SalesforceRecord>(
  query: string,
  options?: QueryOptions,
): QueryResult<SalesforceQueryResult<T>> {
  return useQueryInternal<SalesforceQueryResult<T>>(
    query,
    (q) => sfQuery<T>(q),
    options,
  );
}

// ── useToolingQuery ─────────────────────────────────────────────────────────

export function useToolingQuery<T extends SalesforceRecord = SalesforceRecord>(
  query: string,
  options?: QueryOptions,
): QueryResult<SalesforceQueryResult<T>> {
  return useQueryInternal<SalesforceQueryResult<T>>(
    query,
    (q) => sfToolingQuery<T>(q),
    options,
  );
}

// ── useApiLimits ────────────────────────────────────────────────────────────

export function useApiLimits(): ApiLimitsHook {
  const apiLimits = useAppStore((s) => s.apiLimits);
  const setApiLimits = useAppStore((s) => s.setApiLimits);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const limitsMap = await sfGetApiLimits();

      // Extract the "DailyApiRequests" limit as the primary used/total metric
      const dailyApi = limitsMap['DailyApiRequests'];
      if (mountedRef.current && dailyApi) {
        setApiLimits({
          used: dailyApi.Max - dailyApi.Remaining,
          total: dailyApi.Max,
        });
      }
    } catch (err) {
      if (mountedRef.current) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [setApiLimits]);

  // Auto-fetch on mount if limits have never been checked
  useEffect(() => {
    if (apiLimits.lastChecked === null && sfIsAuthenticated()) {
      void refetch();
    }
  }, [apiLimits.lastChecked, refetch]);

  return {
    used: apiLimits.used,
    total: apiLimits.total,
    lastChecked: apiLimits.lastChecked,
    loading,
    error,
    refetch,
  };
}

// ── useCachedData ───────────────────────────────────────────────────────────

export function useCachedData(cacheKey: string): CacheEntry | undefined {
  return useAppStore((s) => s.cache.get(cacheKey));
}

// ── Internal shared query hook ──────────────────────────────────────────────

function useQueryInternal<T>(
  query: string,
  executor: (query: string) => Promise<T>,
  options?: QueryOptions,
): QueryResult<T> {
  const enabled = options?.enabled ?? true;
  const cacheKey = options?.cacheKey;

  const setCacheEntry = useAppStore((s) => s.setCacheEntry);
  const getCacheEntry = useAppStore((s) => s.getCacheEntry);

  const [data, setData] = useState<T | null>(() => {
    if (cacheKey) {
      const cached = getCacheEntry(cacheKey);
      return cached ? (cached.data as T) : null;
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(() => {
    if (cacheKey) {
      const cached = getCacheEntry(cacheKey);
      return cached ? cached.fetchedAt : null;
    }
    return null;
  });

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executor(query);
      if (!mountedRef.current) return;

      const now = new Date();
      setData(result);
      setLastFetchedAt(now);

      if (cacheKey) {
        setCacheEntry(cacheKey, result);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [query, executor, cacheKey, setCacheEntry]);

  // Auto-fetch when enabled and query changes
  useEffect(() => {
    if (!enabled) return;
    void refetch();
  }, [enabled, refetch]);

  return { data, loading, error, refetch, lastFetchedAt };
}
