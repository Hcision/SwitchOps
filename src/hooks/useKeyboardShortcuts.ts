import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/services/store';
import { TOOLS } from '@/app/toolConfig';

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const setActiveTool = useAppStore((s) => s.setActiveTool);
  const toggleGlobalSearch = useAppStore((s) => s.toggleGlobalSearch);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        if (e.key === 'Escape') {
          (target as HTMLInputElement).blur();
        }
        return;
      }

      // Ctrl+K — global search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        toggleGlobalSearch();
        return;
      }

      // Ctrl+E — export current view (dispatch custom event for active tool)
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('switchops:export'));
        return;
      }

      // Ctrl+1 through Ctrl+9 — jump to tool
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const toolNum = parseInt(e.key, 10);
        const tool = TOOLS.find((t) => t.number === toolNum);
        if (tool) {
          setActiveTool(tool.id);
          navigate(`/tool/${tool.id}`);
        }
        return;
      }

      // Escape — close modals (handled by Modal component) or global search
      if (e.key === 'Escape') {
        const globalSearchOpen = useAppStore.getState().ui.globalSearchOpen;
        if (globalSearchOpen) {
          toggleGlobalSearch();
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, setActiveTool, toggleGlobalSearch]);
}
