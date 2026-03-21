import { Sun, Moon, LogOut } from 'lucide-react';
import { useAppStore } from '../services/store';
import { getToolById } from '../app/toolConfig';
import { logout } from '../services/salesforce';

export default function TopBar() {
  const auth = useAppStore((s) => s.auth);
  const darkMode = useAppStore((s) => s.ui.darkMode);
  const activeToolId = useAppStore((s) => s.ui.activeToolId);
  const apiLimits = useAppStore((s) => s.apiLimits);
  const toggleDarkMode = useAppStore((s) => s.toggleDarkMode);
  const clearAuth = useAppStore((s) => s.clearAuth);

  const activeTool = activeToolId ? getToolById(activeToolId) : null;

  const handleLogout = () => {
    logout();
    clearAuth();
  };

  return (
    <header
      className="flex items-center justify-between px-4 h-14 shrink-0
                 border-b border-gray-200 dark:border-gray-700
                 bg-white dark:bg-gray-900"
    >
      {/* ── Left: Breadcrumb ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-gray-400 dark:text-gray-500">SwitchOps</span>
        {activeTool && (
          <>
            <span className="text-gray-300 dark:text-gray-600">/</span>
            <span className="font-medium text-gray-800 dark:text-gray-200 truncate">
              {activeTool.name}
            </span>
          </>
        )}
      </div>

      {/* ── Right: org info, user, controls ───────────────────────────────── */}
      <div className="flex items-center gap-4">
        {/* Connected org */}
        {auth.isAuthenticated && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-600 dark:text-gray-400 hidden sm:inline">
              {auth.orgName}
            </span>
            <span
              className={`
                px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide
                ${
                  auth.orgType === 'production'
                    ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                }
              `}
            >
              {auth.orgType === 'production' ? 'PRODUCTION' : 'SANDBOX'}
            </span>
          </div>
        )}

        {/* API usage */}
        {auth.isAuthenticated && apiLimits.total > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500 hidden md:inline">
            {apiLimits.used.toLocaleString()} / {apiLimits.total.toLocaleString()} API calls
          </span>
        )}

        {/* User name */}
        {auth.isAuthenticated && (
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 hidden lg:inline">
            {auth.userName}
          </span>
        )}

        {/* Dark mode toggle */}
        <button
          onClick={toggleDarkMode}
          className="p-2 rounded-lg text-gray-500 dark:text-gray-400
                     hover:bg-gray-100 dark:hover:bg-gray-800
                     transition-colors duration-150 cursor-pointer"
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* Disconnect */}
        {auth.isAuthenticated && (
          <button
            onClick={handleLogout}
            className="p-2 rounded-lg text-gray-500 dark:text-gray-400
                       hover:bg-red-50 hover:text-red-600
                       dark:hover:bg-red-900/30 dark:hover:text-red-400
                       transition-colors duration-150 cursor-pointer"
            title="Disconnect"
          >
            <LogOut className="w-5 h-5" />
          </button>
        )}
      </div>
    </header>
  );
}
