import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from './services/store';
import { isAuthenticated } from './services/salesforce';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import LoginScreen from './components/LoginScreen';
import OAuthCallback from './components/OAuthCallback';
import LoadingSpinner from './components/LoadingSpinner';
import GlobalSearch from './components/GlobalSearch';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

// Lazy-loaded tool modules for code splitting
const FlowGraph = lazy(() => import('./tools/tool-01-flow-graph/FlowGraph'));
const SapMonitor = lazy(() => import('./tools/tool-02-sap-monitor/SapMonitor'));
const PermissionMapper = lazy(() => import('./tools/tool-03-permission-mapper/PermissionMapper'));
const ValidationExplorer = lazy(() => import('./tools/tool-04-validation-explorer/ValidationExplorer'));
const QuoteChecker = lazy(() => import('./tools/tool-05-quote-checker/QuoteChecker'));
const MetadataConsole = lazy(() => import('./tools/tool-06-metadata-console/MetadataConsole'));
const DeployAnalyzer = lazy(() => import('./tools/tool-07-deploy-analyzer/DeployAnalyzer'));
const WorkOrderTracker = lazy(() => import('./tools/tool-08-workorder-tracker/WorkOrderTracker'));
const AutomationSwitch = lazy(() => import('./tools/tool-09-automation-switch/AutomationSwitch'));
const FieldLineage = lazy(() => import('./tools/tool-10-field-lineage/FieldLineage'));
const FslLoader = lazy(() => import('./tools/tool-11-fsl-loader/FslLoader'));
const CpqLoader = lazy(() => import('./tools/tool-12-cpq-loader/CpqLoader'));

const TOOL_ROUTES: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  'flow-graph': FlowGraph,
  'sap-monitor': SapMonitor,
  'permission-mapper': PermissionMapper,
  'validation-explorer': ValidationExplorer,
  'quote-checker': QuoteChecker,
  'metadata-console': MetadataConsole,
  'deploy-analyzer': DeployAnalyzer,
  'wo-tracker': WorkOrderTracker,
  'automation-switch': AutomationSwitch,
  'field-lineage': FieldLineage,
  'fsl-loader': FslLoader,
  'cpq-loader': CpqLoader,
};

function ToolPage({ toolId }: { toolId: string }) {
  const setActiveTool = useAppStore((s) => s.setActiveTool);

  useEffect(() => {
    setActiveTool(toolId);
    return () => setActiveTool(null);
  }, [toolId, setActiveTool]);

  const Component = TOOL_ROUTES[toolId];
  if (!Component) return <Navigate to="/" replace />;

  return (
    <Suspense fallback={<LoadingSpinner message="Loading tool..." />}>
      <Component />
    </Suspense>
  );
}

function Dashboard() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-lg">
        <h2 className="text-2xl font-bold text-surface-800 dark:text-surface-200 mb-2">
          Welcome to SwitchOps
        </h2>
        <p className="text-surface-500 dark:text-surface-400">
          Select a tool from the sidebar to get started.
        </p>
      </div>
    </div>
  );
}

function AuthenticatedLayout() {
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar />
        <main className="flex-1 overflow-auto p-6 bg-surface-50 dark:bg-surface-950">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            {Object.keys(TOOL_ROUTES).map((toolId) => (
              <Route
                key={toolId}
                path={`/tool/${toolId}`}
                element={<ToolPage toolId={toolId} />}
              />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <GlobalSearch />
    </div>
  );
}

export default function App() {
  const authState = useAppStore((s) => s.auth);
  const darkMode = useAppStore((s) => s.ui.darkMode);

  // Sync dark mode class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Check if we have in-memory auth
  const authenticated = authState.isAuthenticated && isAuthenticated();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/callback" element={<OAuthCallback />} />
        <Route
          path="/*"
          element={authenticated ? <AuthenticatedLayout /> : <LoginScreen />}
        />
      </Routes>
    </BrowserRouter>
  );
}
