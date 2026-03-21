import { Loader2 } from 'lucide-react';

interface Props {
  message?: string;
}

export default function LoadingSpinner({ message }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[200px] gap-3">
      <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
      {message && (
        <p className="text-sm text-surface-500 dark:text-surface-400">{message}</p>
      )}
    </div>
  );
}
