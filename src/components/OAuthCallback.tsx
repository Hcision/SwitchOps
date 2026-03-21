import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '../services/store';
import { handleCallback, query } from '../services/salesforce';

export default function OAuthCallback() {
  const navigate = useNavigate();
  const setAuth = useAppStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    processCallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function processCallback() {
    try {
      const { userId, instanceUrl, isSandbox } = await handleCallback();

      // Fetch user info
      const userResult = await query(
        `SELECT Id, Name, Username FROM User WHERE Id = '${userId}'`,
      );
      const user = userResult.records?.[0] as
        | { Name: string; Username: string }
        | undefined;

      // Fetch org info
      const orgResult = await query(
        'SELECT Name, OrganizationType, IsSandbox FROM Organization',
      );
      const org = orgResult.records?.[0] as
        | { Name: string; OrganizationType: string; IsSandbox: boolean }
        | undefined;

      setAuth({
        isAuthenticated: true,
        userName: user?.Name ?? '',
        orgName: org?.Name ?? '',
        orgType: isSandbox || org?.IsSandbox ? 'sandbox' : 'production',
        instanceUrl,
      });

      navigate('/', { replace: true });
    } catch (err) {
      console.error('OAuth callback failed:', err);
      setError(err instanceof Error ? err.message : 'Authentication failed. Please try again.');
    }
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-950 px-4">
        <div
          className="w-full max-w-sm rounded-2xl shadow-lg
                      bg-white dark:bg-gray-900
                      border border-gray-200 dark:border-gray-700
                      p-8 text-center"
        >
          <div className="text-red-500 text-4xl mb-4">!</div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Connection Failed
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{error}</p>
          <button
            onClick={() => navigate('/', { replace: true })}
            className="px-6 py-2 rounded-lg font-medium text-white
                       bg-indigo-500 hover:bg-indigo-600
                       transition-colors duration-150 cursor-pointer"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-950">
      <Loader2 className="w-10 h-10 text-indigo-500 animate-spin mb-4" />
      <p className="text-sm text-gray-500 dark:text-gray-400">Connecting to Salesforce...</p>
    </div>
  );
}
