import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  title?: string;
  message: string;
  details?: string;
  onRetry?: () => void;
}

export default function ErrorAlert({ title = 'Error', message, details, onRetry }: Props) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-red-800 dark:text-red-300">{title}</h4>
          <p className="text-sm text-red-700 dark:text-red-400 mt-1">{message}</p>
          {details && (
            <div className="mt-2">
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 dark:hover:text-red-300"
              >
                {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {showDetails ? 'Hide details' : 'Show details'}
              </button>
              {showDetails && (
                <pre className="mt-2 p-2 bg-red-100 dark:bg-red-900/30 rounded text-xs text-red-800 dark:text-red-300 overflow-auto max-h-40">
                  {details}
                </pre>
              )}
            </div>
          )}
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 px-4 py-1.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
