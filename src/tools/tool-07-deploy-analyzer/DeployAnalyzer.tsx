// ---------------------------------------------------------------------------
// Tool 07 - Deployment Impact Analyzer
// ---------------------------------------------------------------------------
// Parses `git diff --name-only` output to identify changed Salesforce
// components, queries MetadataComponentDependency to build a dependency tree,
// computes a per-component risk score, and generates a deployment checklist.
// ---------------------------------------------------------------------------

import { useState, useCallback, useMemo } from 'react';
import {
  GitPullRequest,
  Search,
  RefreshCw,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  FileCode,
  Zap,
  Box,
  Layout,
} from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { useAppStore } from '@/services/store';
import { toolingQuery } from '@/services/salesforce';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RiskLevel = 'Critical' | 'High' | 'Medium' | 'Low';

type ComponentTypeName =
  | 'Apex Class'
  | 'Apex Trigger'
  | 'Flow'
  | 'Custom Field'
  | 'Visualforce Page'
  | 'LWC'
  | 'Aura Component'
  | 'Unknown';

interface ParsedComponent {
  /** Raw file path from git diff */
  filePath: string;
  /** Extracted component name (e.g. "AssetCaseCreation") */
  name: string;
  /** Metadata type (e.g. "Apex Class") */
  type: ComponentTypeName;
  /** Parent object name for field-level metadata */
  parentObject?: string;
}

interface DependencyRecord {
  MetadataComponentName: string;
  MetadataComponentType: string;
  RefMetadataComponentName: string;
  RefMetadataComponentType: string;
}

interface ComponentAnalysis {
  component: ParsedComponent;
  risk: RiskLevel;
  riskReasons: string[];
  dependencyCount: number;
  dependents: DependencyRecord[];
  references: DependencyRecord[];
}

interface ChecklistItem {
  label: string;
  category: 'pre-deploy' | 'deploy' | 'post-deploy';
  required: boolean;
  checked: boolean;
}

type TabId = 'input' | 'dependencies' | 'risk' | 'checklist';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEY = 'tool-07-deploy-analyzer';

/**
 * Rules to extract component name + type from an SFDX path.
 * Order matters: first match wins.
 */
const PATH_RULES: {
  pattern: RegExp;
  type: ComponentTypeName;
  nameExtractor: (match: RegExpMatchArray) => string;
  objectExtractor?: (match: RegExpMatchArray) => string;
}[] = [
  {
    pattern: /\/classes\/([^/]+)\.cls(?:-meta\.xml)?$/,
    type: 'Apex Class',
    nameExtractor: (m) => m[1],
  },
  {
    pattern: /\/triggers\/([^/]+)\.trigger(?:-meta\.xml)?$/,
    type: 'Apex Trigger',
    nameExtractor: (m) => m[1],
  },
  {
    pattern: /\/flows\/([^/]+)\.flow-meta\.xml$/,
    type: 'Flow',
    nameExtractor: (m) => m[1],
  },
  {
    pattern: /\/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/,
    type: 'Custom Field',
    nameExtractor: (m) => m[2],
    objectExtractor: (m) => m[1],
  },
  {
    pattern: /\/pages\/([^/]+)\.page(?:-meta\.xml)?$/,
    type: 'Visualforce Page',
    nameExtractor: (m) => m[1],
  },
  {
    pattern: /\/lwc\/([^/]+)\//,
    type: 'LWC',
    nameExtractor: (m) => m[1],
  },
  {
    pattern: /\/aura\/([^/]+)\//,
    type: 'Aura Component',
    nameExtractor: (m) => m[1],
  },
];

const RISK_COLORS: Record<RiskLevel, string> = {
  Critical: 'bg-red-500',
  High: 'bg-orange-500',
  Medium: 'bg-amber-400',
  Low: 'bg-green-500',
};

const RISK_BADGE_VARIANT: Record<RiskLevel, 'danger' | 'warning' | 'info' | 'success'> = {
  Critical: 'danger',
  High: 'warning',
  Medium: 'info',
  Low: 'success',
};

const TYPE_ICONS: Record<ComponentTypeName, typeof FileCode> = {
  'Apex Class': FileCode,
  'Apex Trigger': Zap,
  Flow: GitPullRequest,
  'Custom Field': Box,
  'Visualforce Page': Layout,
  LWC: Box,
  'Aura Component': Layout,
  Unknown: FileCode,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a single SFDX path into a ParsedComponent (or null if unrecognised). */
function parsePath(filePath: string): ParsedComponent | null {
  const normalised = filePath.replace(/\\/g, '/').trim();
  if (!normalised) return null;

  for (const rule of PATH_RULES) {
    const match = normalised.match(rule.pattern);
    if (match) {
      return {
        filePath: normalised,
        name: rule.nameExtractor(match),
        type: rule.type,
        parentObject: rule.objectExtractor?.(match),
      };
    }
  }

  // Fallback: take the filename without extension
  const segments = normalised.split('/');
  const filename = segments[segments.length - 1] ?? normalised;
  const name = filename.replace(/\.[^.]+$/, '').replace(/-meta$/, '');
  return { filePath: normalised, name, type: 'Unknown' };
}

/** Parse the full git diff output (newline-separated paths). */
function parseDiffOutput(raw: string): ParsedComponent[] {
  const seen = new Set<string>();
  const components: ParsedComponent[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parsePath(trimmed);
    if (!parsed) continue;
    const key = `${parsed.type}::${parsed.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    components.push(parsed);
  }

  return components;
}

/** Determine the risk level for a single component based on its dependencies. */
function computeRisk(
  component: ParsedComponent,
  dependents: DependencyRecord[],
  references: DependencyRecord[],
): { risk: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];

  // --- Critical checks ---
  // Apex called by 3+ flows
  if (component.type === 'Apex Class') {
    const flowCallers = dependents.filter(
      (d) => d.MetadataComponentType === 'Flow' || d.MetadataComponentType === 'FlowDefinition',
    );
    if (flowCallers.length >= 3) {
      reasons.push(`Referenced by ${flowCallers.length} flows`);
      return { risk: 'Critical', reasons };
    }
  }
  // Custom field used in validation rules
  if (component.type === 'Custom Field') {
    const vrRefs = dependents.filter((d) => d.MetadataComponentType === 'ValidationRule');
    if (vrRefs.length > 0) {
      reasons.push(`Used in ${vrRefs.length} validation rule(s)`);
      return { risk: 'Critical', reasons };
    }
  }
  // Trigger on a heavily-referenced object
  if (component.type === 'Apex Trigger' && dependents.length >= 5) {
    reasons.push(`Trigger with ${dependents.length} dependents`);
    return { risk: 'Critical', reasons };
  }

  // --- High checks ---
  if (component.type === 'Flow') {
    const flowRefs = [...dependents, ...references].filter(
      (d) =>
        d.MetadataComponentType === 'Flow' ||
        d.RefMetadataComponentType === 'Flow' ||
        d.MetadataComponentType === 'FlowDefinition' ||
        d.RefMetadataComponentType === 'FlowDefinition',
    );
    if (flowRefs.length > 0) {
      reasons.push(`Part of an automation chain (${flowRefs.length} connected flow(s))`);
      return { risk: 'High', reasons };
    }
  }
  if (dependents.length >= 3) {
    reasons.push(`${dependents.length} components depend on this`);
    return { risk: 'High', reasons };
  }

  // --- Medium checks ---
  const layoutRefs = dependents.filter(
    (d) =>
      d.MetadataComponentType === 'Layout' ||
      d.MetadataComponentType === 'PermissionSet' ||
      d.MetadataComponentType === 'Profile',
  );
  if (layoutRefs.length > 0) {
    reasons.push(`Referenced in ${layoutRefs.length} layout(s)/permission set(s)`);
    return { risk: 'Medium', reasons };
  }
  if (dependents.length >= 1) {
    reasons.push(`${dependents.length} dependent(s)`);
    return { risk: 'Medium', reasons };
  }

  // --- Low ---
  reasons.push('No significant downstream dependencies detected');
  return { risk: 'Low', reasons };
}

/** Build the initial checklist based on the analysis results. */
function buildChecklist(analyses: ComponentAnalysis[]): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const types = new Set(analyses.map((a) => a.component.type));
  const overallRisk = analyses.reduce<RiskLevel>(
    (worst, a) => {
      const order: RiskLevel[] = ['Low', 'Medium', 'High', 'Critical'];
      return order.indexOf(a.risk) > order.indexOf(worst) ? a.risk : worst;
    },
    'Low',
  );

  // Pre-deploy
  items.push({
    label: 'Back up metadata from target org',
    category: 'pre-deploy',
    required: true,
    checked: false,
  });

  if (types.has('Apex Class') || types.has('Apex Trigger')) {
    items.push({
      label: 'Run all Apex unit tests in source org',
      category: 'pre-deploy',
      required: true,
      checked: false,
    });
  }

  if (types.has('Flow')) {
    items.push({
      label: 'Deactivate existing flow versions before deploying new ones',
      category: 'pre-deploy',
      required: false,
      checked: false,
    });
  }

  if (types.has('Custom Field')) {
    items.push({
      label: 'Verify field-level security assignments in target org',
      category: 'pre-deploy',
      required: true,
      checked: false,
    });
  }

  if (overallRisk === 'Critical' || overallRisk === 'High') {
    items.push({
      label: 'Notify stakeholders of high-risk deployment',
      category: 'pre-deploy',
      required: true,
      checked: false,
    });
    items.push({
      label: 'Schedule deployment during low-traffic window',
      category: 'pre-deploy',
      required: false,
      checked: false,
    });
  }

  // Deploy
  items.push({
    label: `Deploy ${analyses.length} component(s) using validated deployment`,
    category: 'deploy',
    required: true,
    checked: false,
  });

  if (types.has('Apex Class') || types.has('Apex Trigger')) {
    items.push({
      label: 'Run specified tests during deployment',
      category: 'deploy',
      required: true,
      checked: false,
    });
  }

  // Post-deploy
  items.push({
    label: 'Verify deployment status in Setup > Deployment Status',
    category: 'post-deploy',
    required: true,
    checked: false,
  });

  if (types.has('Flow')) {
    items.push({
      label: 'Activate new flow versions in target org',
      category: 'post-deploy',
      required: true,
      checked: false,
    });
  }

  if (types.has('Custom Field')) {
    items.push({
      label: 'Verify page layouts include new/updated fields',
      category: 'post-deploy',
      required: false,
      checked: false,
    });
  }

  items.push({
    label: 'Smoke-test critical business processes end-to-end',
    category: 'post-deploy',
    required: true,
    checked: false,
  });

  if (overallRisk === 'Critical' || overallRisk === 'High') {
    items.push({
      label: 'Monitor error logs for 30 minutes post-deploy',
      category: 'post-deploy',
      required: true,
      checked: false,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DeployAnalyzer() {
  // ── Global store ────────────────────────────────────────────────────────
  const { auth, setCacheEntry, getCacheEntry } = useAppStore();

  // ── Local state ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('input');
  const [diffInput, setDiffInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchType, setSearchType] = useState<ComponentTypeName>('Apex Class');
  const [parsedComponents, setParsedComponents] = useState<ParsedComponent[]>([]);
  const [analyses, setAnalyses] = useState<ComponentAnalysis[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Parse the diff input ────────────────────────────────────────────────
  const handleParse = useCallback(() => {
    const components = parseDiffOutput(diffInput);
    setParsedComponents(components);
    setError(null);
  }, [diffInput]);

  // ── Add a single component via search ───────────────────────────────────
  const handleAddComponent = useCallback(() => {
    const trimmed = searchTerm.trim();
    if (!trimmed) return;
    const key = `${searchType}::${trimmed}`;
    const alreadyExists = parsedComponents.some(
      (c) => `${c.type}::${c.name}` === key,
    );
    if (alreadyExists) return;
    setParsedComponents((prev) => [
      ...prev,
      { filePath: `(manual) ${trimmed}`, name: trimmed, type: searchType },
    ]);
    setSearchTerm('');
  }, [searchTerm, searchType, parsedComponents]);

  // ── Remove a parsed component ───────────────────────────────────────────
  const handleRemoveComponent = useCallback((name: string, type: ComponentTypeName) => {
    setParsedComponents((prev) =>
      prev.filter((c) => !(c.name === name && c.type === type)),
    );
  }, []);

  // ── Analyze dependencies ────────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (parsedComponents.length === 0) {
      setError('Add at least one component to analyze.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      // Check cache
      const cacheKey = `${CACHE_KEY}::${parsedComponents.map((c) => c.name).sort().join(',')}`;
      const cached = getCacheEntry(cacheKey);
      if (cached) {
        const data = cached.data as { analyses: ComponentAnalysis[]; checklist: ChecklistItem[] };
        setAnalyses(data.analyses);
        setChecklist(data.checklist);
        setActiveTab('dependencies');
        return;
      }

      const names = parsedComponents.map((c) => c.name);
      const namesList = names.map((n) => `'${n}'`).join(',');

      // Query: what does each changed component DEPEND ON (references)
      const refsQuery = `SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE MetadataComponentName IN (${namesList})`;

      // Query: what depends ON each changed component (dependents)
      const depsQuery = `SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentName IN (${namesList})`;

      const [refsResult, depsResult] = await Promise.all([
        toolingQuery<DependencyRecord & { Id?: string; attributes?: { type: string; url: string } }>(refsQuery),
        toolingQuery<DependencyRecord & { Id?: string; attributes?: { type: string; url: string } }>(depsQuery),
      ]);

      const refsRecords = refsResult.records as DependencyRecord[];
      const depsRecords = depsResult.records as DependencyRecord[];

      const results: ComponentAnalysis[] = parsedComponents.map((component) => {
        const references = refsRecords.filter(
          (r) => r.MetadataComponentName === component.name,
        );
        const dependents = depsRecords.filter(
          (r) => r.RefMetadataComponentName === component.name,
        );
        const { risk, reasons } = computeRisk(component, dependents, references);

        return {
          component,
          risk,
          riskReasons: reasons,
          dependencyCount: dependents.length + references.length,
          dependents,
          references,
        };
      });

      const generatedChecklist = buildChecklist(results);

      // Cache results
      setCacheEntry(cacheKey, { analyses: results, checklist: generatedChecklist });

      setAnalyses(results);
      setChecklist(generatedChecklist);
      setActiveTab('dependencies');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }, [parsedComponents, getCacheEntry, setCacheEntry]);

  // ── Toggle dependency tree nodes ────────────────────────────────────────
  const toggleNode = useCallback((nodeKey: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeKey)) {
        next.delete(nodeKey);
      } else {
        next.add(nodeKey);
      }
      return next;
    });
  }, []);

  // ── Toggle checklist items ──────────────────────────────────────────────
  const toggleChecklist = useCallback((index: number) => {
    setChecklist((prev) =>
      prev.map((item, i) => (i === index ? { ...item, checked: !item.checked } : item)),
    );
  }, []);

  // ── Computed values ─────────────────────────────────────────────────────
  const overallRisk = useMemo<RiskLevel>(() => {
    if (analyses.length === 0) return 'Low';
    const order: RiskLevel[] = ['Low', 'Medium', 'High', 'Critical'];
    return analyses.reduce<RiskLevel>(
      (worst, a) => (order.indexOf(a.risk) > order.indexOf(worst) ? a.risk : worst),
      'Low',
    );
  }, [analyses]);

  const totalAffected = useMemo(() => {
    const unique = new Set<string>();
    for (const a of analyses) {
      for (const d of a.dependents) {
        unique.add(`${d.MetadataComponentType}::${d.MetadataComponentName}`);
      }
      for (const r of a.references) {
        unique.add(`${r.RefMetadataComponentType}::${r.RefMetadataComponentName}`);
      }
    }
    return unique.size;
  }, [analyses]);

  const checklistProgress = useMemo(() => {
    if (checklist.length === 0) return 0;
    return Math.round((checklist.filter((c) => c.checked).length / checklist.length) * 100);
  }, [checklist]);

  // ── Risk table columns ─────────────────────────────────────────────────
  const riskColumns = useMemo<ColumnDef<ComponentAnalysis, unknown>[]>(
    () => [
      {
        accessorKey: 'component.name',
        header: 'Component',
        accessorFn: (row) => row.component.name,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            {(() => {
              const Icon = TYPE_ICONS[row.original.component.type] ?? FileCode;
              return <Icon className="w-4 h-4 text-surface-400" />;
            })()}
            <span className="font-medium text-surface-800 dark:text-surface-200">
              {row.original.component.name}
            </span>
          </div>
        ),
      },
      {
        accessorKey: 'component.type',
        header: 'Type',
        accessorFn: (row) => row.component.type,
        cell: ({ row }) => (
          <StatusBadge label={row.original.component.type} variant="neutral" />
        ),
      },
      {
        accessorKey: 'risk',
        header: 'Risk',
        cell: ({ row }) => (
          <StatusBadge
            label={row.original.risk}
            variant={RISK_BADGE_VARIANT[row.original.risk]}
          />
        ),
      },
      {
        accessorKey: 'dependencyCount',
        header: 'Dependencies',
      },
      {
        accessorKey: 'riskReasons',
        header: 'Reason',
        accessorFn: (row) => row.riskReasons.join('; '),
        cell: ({ row }) => (
          <span className="text-xs text-surface-500 dark:text-surface-400">
            {row.original.riskReasons.join('; ')}
          </span>
        ),
      },
    ],
    [],
  );

  // ── Tab buttons ─────────────────────────────────────────────────────────
  const tabs: { id: TabId; label: string; disabled: boolean }[] = [
    { id: 'input', label: 'Input', disabled: false },
    { id: 'dependencies', label: 'Dependencies', disabled: analyses.length === 0 },
    { id: 'risk', label: 'Risk Analysis', disabled: analyses.length === 0 },
    { id: 'checklist', label: 'Checklist', disabled: checklist.length === 0 },
  ];

  // ── Render helpers ──────────────────────────────────────────────────────

  /** Render a single dependency tree node recursively. */
  const renderTreeNode = (analysis: ComponentAnalysis) => {
    const nodeKey = `${analysis.component.type}::${analysis.component.name}`;
    const isExpanded = expandedNodes.has(nodeKey);
    const Icon = TYPE_ICONS[analysis.component.type] ?? FileCode;

    return (
      <div key={nodeKey} className="mb-2">
        {/* Node header */}
        <button
          onClick={() => toggleNode(nodeKey)}
          className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg
                     hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
        >
          {analysis.dependents.length + analysis.references.length > 0 ? (
            isExpanded ? (
              <ChevronDown className="w-4 h-4 text-surface-400 shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 text-surface-400 shrink-0" />
            )
          ) : (
            <span className="w-4" />
          )}
          <Icon className="w-4 h-4 text-surface-400 shrink-0" />
          <span className="font-medium text-surface-800 dark:text-surface-200">
            {analysis.component.name}
          </span>
          <StatusBadge label={analysis.component.type} variant="neutral" />
          <StatusBadge
            label={analysis.risk}
            variant={RISK_BADGE_VARIANT[analysis.risk]}
          />
          <span className="ml-auto text-xs text-surface-400">
            {analysis.dependents.length} dependent(s), {analysis.references.length} reference(s)
          </span>
        </button>

        {/* Expanded children */}
        {isExpanded && (
          <div className="ml-8 mt-1 border-l-2 border-surface-200 dark:border-surface-700 pl-4 space-y-1">
            {analysis.dependents.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-1">
                  Dependents (what depends on this)
                </p>
                {analysis.dependents.map((dep, i) => (
                  <div
                    key={`dep-${i}`}
                    className="flex items-center gap-2 px-2 py-1 text-sm text-surface-600 dark:text-surface-400"
                  >
                    <FileCode className="w-3.5 h-3.5 text-surface-400" />
                    <span>{dep.MetadataComponentName}</span>
                    <StatusBadge label={dep.MetadataComponentType} variant="neutral" />
                  </div>
                ))}
              </div>
            )}
            {analysis.references.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-1">
                  References (what this depends on)
                </p>
                {analysis.references.map((ref, i) => (
                  <div
                    key={`ref-${i}`}
                    className="flex items-center gap-2 px-2 py-1 text-sm text-surface-600 dark:text-surface-400"
                  >
                    <FileCode className="w-3.5 h-3.5 text-surface-400" />
                    <span>{ref.RefMetadataComponentName}</span>
                    <StatusBadge label={ref.RefMetadataComponentType} variant="neutral" />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Main render ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200 dark:border-surface-700">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary-100 dark:bg-primary-900/30">
            <GitPullRequest className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100">
              Deployment Impact Analyzer
            </h2>
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Paste git diff paths to analyze deployment risk and dependencies
            </p>
          </div>
        </div>

        {/* Blast radius summary (visible after analysis) */}
        {analyses.length > 0 && (
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                {parsedComponents.length}
              </p>
              <p className="text-xs text-surface-500 dark:text-surface-400">Changed</p>
            </div>
            <div className="w-px h-10 bg-surface-200 dark:bg-surface-700" />
            <div className="text-center">
              <p className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                {totalAffected}
              </p>
              <p className="text-xs text-surface-500 dark:text-surface-400">Affected</p>
            </div>
            <div className="w-px h-10 bg-surface-200 dark:bg-surface-700" />
            <div className="text-center">
              <div className={`mx-auto w-8 h-8 rounded-full flex items-center justify-center ${RISK_COLORS[overallRisk]}`}>
                <AlertTriangle className="w-4 h-4 text-white" />
              </div>
              <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                {overallRisk}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="flex gap-1 px-6 pt-3 border-b border-surface-200 dark:border-surface-700">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            disabled={tab.disabled}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
              ${
                activeTab === tab.id
                  ? 'bg-white dark:bg-surface-800 text-primary-600 dark:text-primary-400 border border-b-0 border-surface-200 dark:border-surface-700'
                  : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
              }
              ${tab.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <div className="px-6 pt-4">
          <ErrorAlert message={error} onRetry={handleAnalyze} />
        </div>
      )}

      {/* ── Loading ───────────────────────────────────────────────────────── */}
      {loading && <LoadingSpinner message="Querying MetadataComponentDependency..." />}

      {/* ── Tab content ───────────────────────────────────────────────────── */}
      {!loading && (
        <div className="flex-1 overflow-auto p-6">
          {/* ──────────── INPUT TAB ──────────── */}
          {activeTab === 'input' && (
            <div className="space-y-6">
              {/* Textarea for git diff output */}
              <div>
                <label className="block text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">
                  Paste <code className="px-1.5 py-0.5 rounded bg-surface-100 dark:bg-surface-800 text-xs font-mono">git diff --name-only</code> output
                </label>
                <textarea
                  value={diffInput}
                  onChange={(e) => setDiffInput(e.target.value)}
                  placeholder={`force-app/main/default/classes/AssetCaseCreation.cls\nforce-app/main/default/flows/Case_Auto_Assignment.flow-meta.xml\nforce-app/main/default/objects/Case/fields/Priority__c.field-meta.xml`}
                  rows={10}
                  className="w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-700
                             bg-surface-50 dark:bg-surface-800 text-surface-800 dark:text-surface-200
                             font-mono text-sm resize-y
                             focus:outline-none focus:ring-2 focus:ring-primary-500/40
                             placeholder:text-surface-400 dark:placeholder:text-surface-600"
                />
                <div className="flex items-center gap-3 mt-3">
                  <button
                    onClick={handleParse}
                    disabled={!diffInput.trim()}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-surface-200 dark:bg-surface-700
                               text-surface-700 dark:text-surface-300 hover:bg-surface-300 dark:hover:bg-surface-600
                               disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Parse Paths
                  </button>
                  <button
                    onClick={handleAnalyze}
                    disabled={parsedComponents.length === 0 || !auth.isAuthenticated}
                    className="px-5 py-2 text-sm font-medium rounded-lg bg-primary-600 text-white
                               hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed
                               transition-colors flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Analyze
                  </button>
                </div>
              </div>

              {/* Manual search / add single component */}
              <div>
                <label className="block text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">
                  Or add a component manually
                </label>
                <div className="flex items-center gap-2">
                  <select
                    value={searchType}
                    onChange={(e) => setSearchType(e.target.value as ComponentTypeName)}
                    className="px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700
                               bg-surface-50 dark:bg-surface-800 text-surface-800 dark:text-surface-200
                               text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                  >
                    <option value="Apex Class">Apex Class</option>
                    <option value="Apex Trigger">Apex Trigger</option>
                    <option value="Flow">Flow</option>
                    <option value="Custom Field">Custom Field</option>
                    <option value="Visualforce Page">Visualforce Page</option>
                    <option value="LWC">LWC</option>
                    <option value="Aura Component">Aura Component</option>
                  </select>
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddComponent()}
                      placeholder="Component API name..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700
                                 bg-surface-50 dark:bg-surface-800 text-surface-800 dark:text-surface-200
                                 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/40
                                 placeholder:text-surface-400 dark:placeholder:text-surface-600"
                    />
                  </div>
                  <button
                    onClick={handleAddComponent}
                    disabled={!searchTerm.trim()}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-surface-200 dark:bg-surface-700
                               text-surface-700 dark:text-surface-300 hover:bg-surface-300 dark:hover:bg-surface-600
                               disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Parsed components list */}
              {parsedComponents.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">
                    Parsed Components ({parsedComponents.length})
                  </h3>
                  <div className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden">
                    <div className="divide-y divide-surface-100 dark:divide-surface-800">
                      {parsedComponents.map((c) => {
                        const Icon = TYPE_ICONS[c.type] ?? FileCode;
                        return (
                          <div
                            key={`${c.type}::${c.name}`}
                            className="flex items-center justify-between px-4 py-2.5
                                       bg-white dark:bg-surface-900 hover:bg-surface-50 dark:hover:bg-surface-800/50"
                          >
                            <div className="flex items-center gap-3">
                              <Icon className="w-4 h-4 text-surface-400" />
                              <span className="text-sm font-medium text-surface-800 dark:text-surface-200">
                                {c.name}
                              </span>
                              <StatusBadge label={c.type} variant="neutral" />
                              {c.parentObject && (
                                <span className="text-xs text-surface-400">
                                  on {c.parentObject}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-surface-400 font-mono truncate max-w-[300px]">
                                {c.filePath}
                              </span>
                              <button
                                onClick={() => handleRemoveComponent(c.name, c.type)}
                                className="text-surface-400 hover:text-red-500 transition-colors text-xs"
                                title="Remove"
                              >
                                &times;
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ──────────── DEPENDENCIES TAB ──────────── */}
          {activeTab === 'dependencies' && analyses.length > 0 && (
            <div className="space-y-4">
              {/* Blast radius summary */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                  <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-1">
                    Changed Components
                  </p>
                  <p className="text-3xl font-bold text-surface-900 dark:text-surface-100">
                    {parsedComponents.length}
                  </p>
                </div>
                <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                  <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-1">
                    Total Affected
                  </p>
                  <p className="text-3xl font-bold text-surface-900 dark:text-surface-100">
                    {totalAffected}
                  </p>
                </div>
                <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                  <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-1">
                    Overall Risk
                  </p>
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${RISK_COLORS[overallRisk]}`} />
                    <p className="text-xl font-bold text-surface-900 dark:text-surface-100">
                      {overallRisk}
                    </p>
                  </div>
                </div>
              </div>

              {/* Dependency tree */}
              <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl">
                <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700">
                  <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                    Dependency Tree
                  </h3>
                </div>
                <div className="p-3">
                  {analyses.map(renderTreeNode)}
                </div>
              </div>
            </div>
          )}

          {/* ──────────── RISK TAB ──────────── */}
          {activeTab === 'risk' && analyses.length > 0 && (
            <div className="space-y-6">
              {/* Risk distribution bars */}
              <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-3">
                  Risk Distribution
                </h3>
                <div className="flex gap-2 items-end h-24">
                  {(['Critical', 'High', 'Medium', 'Low'] as RiskLevel[]).map((level) => {
                    const count = analyses.filter((a) => a.risk === level).length;
                    const pct = analyses.length > 0 ? (count / analyses.length) * 100 : 0;
                    return (
                      <div key={level} className="flex-1 flex flex-col items-center gap-1">
                        <span className="text-xs font-bold text-surface-700 dark:text-surface-300">
                          {count}
                        </span>
                        <div
                          className={`w-full rounded-t ${RISK_COLORS[level]} transition-all`}
                          style={{ height: `${Math.max(pct, 4)}%` }}
                        />
                        <span className="text-[10px] text-surface-500 dark:text-surface-400">
                          {level}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Risk table */}
              <DataTable
                data={analyses}
                columns={riskColumns}
                title="Component Risk Assessment"
                exportFilename="deploy-risk-analysis"
                pageSize={50}
              />
            </div>
          )}

          {/* ──────────── CHECKLIST TAB ──────────── */}
          {activeTab === 'checklist' && checklist.length > 0 && (
            <div className="space-y-6">
              {/* Progress bar */}
              <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                    Deployment Checklist
                  </h3>
                  <span className="text-sm font-medium text-surface-500 dark:text-surface-400">
                    {checklistProgress}% complete
                  </span>
                </div>
                <div className="w-full h-2 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary-500 rounded-full transition-all duration-300"
                    style={{ width: `${checklistProgress}%` }}
                  />
                </div>
              </div>

              {/* Checklist sections */}
              {(['pre-deploy', 'deploy', 'post-deploy'] as const).map((category) => {
                const items = checklist
                  .map((item, idx) => ({ ...item, idx }))
                  .filter((item) => item.category === category);
                if (items.length === 0) return null;

                const categoryLabel =
                  category === 'pre-deploy'
                    ? 'Pre-Deployment'
                    : category === 'deploy'
                      ? 'Deployment'
                      : 'Post-Deployment';

                return (
                  <div
                    key={category}
                    className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl"
                  >
                    <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700">
                      <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                        {categoryLabel}
                      </h4>
                    </div>
                    <div className="divide-y divide-surface-100 dark:divide-surface-800">
                      {items.map((item) => (
                        <label
                          key={item.idx}
                          className="flex items-center gap-3 px-4 py-3 cursor-pointer
                                     hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={item.checked}
                            onChange={() => toggleChecklist(item.idx)}
                            className="w-4 h-4 rounded border-surface-300 dark:border-surface-600
                                       text-primary-600 focus:ring-primary-500/40"
                          />
                          <span
                            className={`flex-1 text-sm ${
                              item.checked
                                ? 'line-through text-surface-400 dark:text-surface-600'
                                : 'text-surface-700 dark:text-surface-300'
                            }`}
                          >
                            {item.label}
                          </span>
                          {item.required && (
                            <StatusBadge label="Required" variant="warning" />
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
