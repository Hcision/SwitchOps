import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Command } from 'lucide-react';
import { useAppStore } from '@/services/store';
import { TOOLS } from '@/app/toolConfig';

export default function GlobalSearch() {
  const navigate = useNavigate();
  const open = useAppStore((s) => s.ui.globalSearchOpen);
  const toggleGlobalSearch = useAppStore((s) => s.toggleGlobalSearch);
  const setActiveTool = useAppStore((s) => s.setActiveTool);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const filtered = query.trim()
    ? TOOLS.filter(
        (t) =>
          t.name.toLowerCase().includes(query.toLowerCase()) ||
          t.description.toLowerCase().includes(query.toLowerCase()) ||
          t.shortName.toLowerCase().includes(query.toLowerCase()),
      )
    : TOOLS;

  const selectTool = (toolId: string) => {
    setActiveTool(toolId);
    navigate(`/tool/${toolId}`);
    toggleGlobalSearch();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) toggleGlobalSearch();
      }}
    >
      <div className="w-full max-w-lg bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-700 overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-200 dark:border-surface-700">
          <Search className="w-5 h-5 text-surface-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search tools..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length > 0) {
                selectTool(filtered[0].id);
              }
              if (e.key === 'Escape') toggleGlobalSearch();
            }}
            className="flex-1 bg-transparent text-surface-800 dark:text-surface-200 placeholder-surface-400 outline-none text-sm"
          />
          <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium text-surface-400 bg-surface-100 dark:bg-surface-800 rounded border border-surface-200 dark:border-surface-600">
            <Command className="w-3 h-3" />K
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-surface-400">No tools found</div>
          )}
          {filtered.map((tool) => (
            <button
              key={tool.id}
              onClick={() => selectTool(tool.id)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors"
            >
              <span className="flex items-center justify-center w-6 h-6 rounded bg-surface-100 dark:bg-surface-800 text-xs font-bold text-surface-500 dark:text-surface-400">
                {tool.number}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-surface-800 dark:text-surface-200">{tool.name}</div>
                <div className="text-xs text-surface-400 truncate">{tool.description}</div>
              </div>
              <kbd className="hidden sm:block px-1.5 py-0.5 text-[10px] font-medium text-surface-400 bg-surface-100 dark:bg-surface-800 rounded">
                {tool.number <= 9 ? `Ctrl+${tool.number}` : ''}
              </kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
