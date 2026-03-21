type Variant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const STYLES: Record<Variant, string> = {
  success: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  danger: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  neutral: 'bg-surface-100 text-surface-600 dark:bg-surface-700 dark:text-surface-300',
};

interface Props {
  label: string;
  variant?: Variant;
}

export default function StatusBadge({ label, variant = 'neutral' }: Props) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${STYLES[variant]}`}>
      {label}
    </span>
  );
}
