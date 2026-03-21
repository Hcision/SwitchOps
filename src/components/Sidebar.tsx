import { useNavigate } from 'react-router-dom';
import {
  GitBranch,
  CheckSquare,
  Database,
  GitPullRequest,
  Route,
  Activity,
  Truck,
  ToggleLeft,
  Shield,
  FileCheck,
  Upload,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../services/store';
import { CATEGORIES, getToolsByCategory } from '../app/toolConfig';
import type { ToolConfig } from '../app/toolConfig';

// ── Icon map ─────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, LucideIcon> = {
  GitBranch,
  CheckSquare,
  Database,
  GitPullRequest,
  Route,
  Activity,
  Truck,
  ToggleLeft,
  Shield,
  FileCheck,
  Upload,
  Package,
};

function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Zap;
}

// ── Category order ───────────────────────────────────────────────────────────

const CATEGORY_ORDER: ToolConfig['category'][] = [
  'metadata',
  'operations',
  'security',
  'sales',
  'loaders',
];

// ── Component ────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const navigate = useNavigate();
  const collapsed = useAppStore((s) => s.ui.sidebarCollapsed);
  const activeToolId = useAppStore((s) => s.ui.activeToolId);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setActiveTool = useAppStore((s) => s.setActiveTool);

  const grouped = getToolsByCategory();

  const handleToolClick = (tool: ToolConfig) => {
    setActiveTool(tool.id);
    navigate(`/tool/${tool.id}`);
  };

  return (
    <aside
      className={`
        flex flex-col h-screen shrink-0 border-r
        border-gray-200 dark:border-gray-700
        bg-white dark:bg-gray-900
        transition-all duration-300 ease-in-out overflow-hidden
        ${collapsed ? 'w-16' : 'w-[280px]'}
      `}
    >
      {/* ── Logo / Brand ─────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 h-14 shrink-0 border-b
                    border-gray-200 dark:border-gray-700 cursor-pointer"
        onClick={() => {
          setActiveTool(null);
          navigate('/');
        }}
      >
        <Zap className="w-6 h-6 text-indigo-500 shrink-0" />
        {!collapsed && (
          <span className="text-lg font-bold text-gray-900 dark:text-white whitespace-nowrap">
            SwitchOps
          </span>
        )}
      </div>

      {/* ── Tool list ────────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-2">
        {CATEGORY_ORDER.map((cat) => {
          const tools = grouped[cat];
          if (!tools.length) return null;

          return (
            <div key={cat} className="mb-2">
              {/* Category header */}
              {!collapsed && (
                <h3
                  className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider
                             text-gray-400 dark:text-gray-500 select-none"
                >
                  {CATEGORIES[cat]}
                </h3>
              )}

              {collapsed && (
                <div className="mx-auto my-2 w-6 border-t border-gray-200 dark:border-gray-700" />
              )}

              {/* Tools */}
              {tools.map((tool) => {
                const Icon = getIcon(tool.icon);
                const isActive = activeToolId === tool.id;

                return (
                  <button
                    key={tool.id}
                    onClick={() => handleToolClick(tool)}
                    title={collapsed ? tool.name : undefined}
                    className={`
                      flex items-center gap-3 w-full text-left
                      px-3 py-2 mx-1 rounded-lg text-sm
                      transition-colors duration-150 cursor-pointer
                      ${
                        isActive
                          ? 'bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }
                    `}
                    style={{ maxWidth: collapsed ? '56px' : undefined }}
                  >
                    {/* Icon */}
                    <span className="relative shrink-0">
                      <Icon className="w-5 h-5" />
                      {/* Number badge */}
                      <span
                        className={`
                          absolute -top-1.5 -right-2 flex items-center justify-center
                          w-4 h-4 rounded-full text-[9px] font-bold leading-none
                          ${
                            isActive
                              ? 'bg-indigo-500 text-white'
                              : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                          }
                        `}
                      >
                        {tool.number}
                      </span>
                    </span>

                    {/* Name (hidden when collapsed) */}
                    {!collapsed && (
                      <span className="truncate whitespace-nowrap">{tool.name}</span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* ── Collapse toggle ──────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 p-2">
        <button
          onClick={toggleSidebar}
          className="flex items-center justify-center w-full gap-2 py-2 rounded-lg
                     text-gray-500 dark:text-gray-400
                     hover:bg-gray-100 dark:hover:bg-gray-800
                     transition-colors duration-150 cursor-pointer"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeftOpen className="w-5 h-5" />
          ) : (
            <>
              <PanelLeftClose className="w-5 h-5" />
              <span className="text-sm">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
