import { Cloud, Zap } from 'lucide-react';
import { initiateLogin } from '../services/salesforce';

export default function LoginScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-950 px-4">
      <div
        className="w-full max-w-md rounded-2xl shadow-lg
                    bg-white dark:bg-gray-900
                    border border-gray-200 dark:border-gray-700
                    p-8 text-center"
      >
        {/* ── Branding ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <Zap className="w-8 h-8 text-indigo-500" />
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">SwitchOps</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
          HBK Salesforce Ops Toolkit
        </p>

        {/* ── Connection buttons ───────────────────────────────────────── */}
        <div className="flex flex-col gap-4 mb-8">
          {/* Production */}
          <button
            onClick={() => initiateLogin(false)}
            className="flex items-center justify-center gap-3 w-full py-3 px-4
                       rounded-xl font-semibold text-white
                       bg-gradient-to-r from-red-500 to-red-600
                       hover:from-red-600 hover:to-red-700
                       shadow-md hover:shadow-lg
                       transition-all duration-200 cursor-pointer"
          >
            <Cloud className="w-6 h-6" />
            Connect to Production
          </button>

          {/* Sandbox */}
          <button
            onClick={() => initiateLogin(true)}
            className="flex items-center justify-center gap-3 w-full py-3 px-4
                       rounded-xl font-semibold text-white
                       bg-gradient-to-r from-blue-500 to-blue-600
                       hover:from-blue-600 hover:to-blue-700
                       shadow-md hover:shadow-lg
                       transition-all duration-200 cursor-pointer"
          >
            <Cloud className="w-6 h-6" />
            Connect to Sandbox
          </button>
        </div>

        {/* ── Security notice ──────────────────────────────────────────── */}
        <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
          All data stays in your browser. No external servers.
        </p>
      </div>
    </div>
  );
}
