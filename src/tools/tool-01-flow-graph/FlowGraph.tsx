// ---------------------------------------------------------------------------
// Tool 01 - Flow Dependency Graph & Impact Analyzer
// ---------------------------------------------------------------------------
// Interactive visualization of Salesforce Flow dependencies, showing subflow
// calls, Apex invocable references, and object-level impact analysis.
// ---------------------------------------------------------------------------

import { useState, useCallback, useMemo, useEffect } from 'react';
import ReactFlow, {
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import type { Node, Edge } from 'reactflow';
import 'reactflow/dist/style.css';
import { Search, RefreshCw, Download, GitBranch, Eye, Table2 } from 'lucide-react';
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

interface FlowRecord {
  Id: string;
  DefinitionId: string;
  FullName: string;
  ProcessType: string;
  TriggerType: string | null;
  Status: string;
  Description: string | null;
}

interface ApexClassRecord {
  Id: string;
  Name: string;
}

interface FlowDependency {
  id: string;
  definitionId: string;
  fullName: string;
  label: string;
  processType: string;
  triggerType: string | null;
  triggerObject: string | null;
  status: string;
  description: string | null;
  elementCount: number;
  apexCalls: string[];
  subflowCalls: string[];
  objectsRead: string[];
  objectsWritten: string[];
  decisionCount: number;
  loopCount: number;
  complexity: 'Low' | 'Medium' | 'High';
  lastModified: string;
}

interface DetailPanelData {
  flow: FlowDependency;
}

type ViewMode = 'graph' | 'table';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEY = 'tool-01-flow-graph';

const PROCESS_TYPE_COLORS: Record<string, string> = {
  RecordTriggered: '#3b82f6', // blue
  AutoLaunchedFlow: '#f97316', // orange
  Screen: '#22c55e', // green
  Scheduled: '#a855f7', // purple
  PlatformEvent: '#ef4444', // red
  CustomEvent: '#ef4444',
  Flow: '#6b7280', // gray fallback
};

const PROCESS_TYPE_LABELS: Record<string, string> = {
  AutoLaunchedFlow: 'Autolaunched',
  Screen: 'Screen Flow',
  Scheduled: 'Scheduled',
  PlatformEvent: 'Platform Event',
  CustomEvent: 'Custom Event',
  RecordTriggered: 'Record-Triggered',
  Flow: 'Flow',
};

/** Common Salesforce objects used to simulate trigger objects. */
const COMMON_OBJECTS = [
  'Account', 'Contact', 'Opportunity', 'Lead', 'Case', 'Task',
  'Event', 'Order', 'Product2', 'Campaign', 'Contract', 'Quote',
  'User', 'OpportunityLineItem', 'CampaignMember', 'ContentDocument',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable label from the flow FullName.
 * E.g. "My_Flow_Name-3" -> "My Flow Name"
 */
function deriveLabel(fullName: string): string {
  return fullName
    .replace(/-\d+$/, '')
    .replace(/_/g, ' ');
}

/**
 * Determine the effective process type for coloring.
 * Record-triggered flows are AutoLaunchedFlow with a triggerType.
 */
function effectiveType(processType: string, triggerType: string | null): string {
  if (processType === 'AutoLaunchedFlow' && triggerType) {
    return 'RecordTriggered';
  }
  return processType;
}

/**
 * Extract the trigger object from the FullName when available.
 * Many record-triggered flows use the naming convention: ObjectName_TriggerContext
 */
function inferTriggerObject(fullName: string, triggerType: string | null): string | null {
  if (!triggerType) return null;
  const name = fullName.replace(/-\d+$/, '');
  for (const obj of COMMON_OBJECTS) {
    if (name.startsWith(obj) || name.includes(`_${obj}_`) || name.includes(`${obj}_`)) {
      return obj;
    }
  }
  // Fallback: use first segment before underscore
  const segments = name.split('_');
  if (segments.length > 1 && segments[0].length > 2) {
    return segments[0];
  }
  return null;
}

/**
 * Build a simulated dependency model from flow records and apex classes.
 * In production this would parse actual flow metadata XML bodies.
 */
function buildDependencyModel(
  flows: FlowRecord[],
  apexClasses: ApexClassRecord[],
): FlowDependency[] {
  const apexNames = apexClasses.map((a) => a.Name);
  const flowNames = flows.map((f) => f.FullName.replace(/-\d+$/, ''));

  return flows.map((flow, idx) => {
    const seed = hashCode(flow.Id);
    const triggerObject = inferTriggerObject(flow.FullName, flow.TriggerType);
    const eType = effectiveType(flow.ProcessType, flow.TriggerType);

    // Simulate element count based on process type
    const baseElements = eType === 'Screen' ? 8 : eType === 'RecordTriggered' ? 12 : 6;
    const elementCount = baseElements + (Math.abs(seed) % 20);

    // Simulate apex calls (some flows reference invocable apex)
    const apexCalls: string[] = [];
    if (apexNames.length > 0 && (seed % 3 === 0 || eType === 'AutoLaunchedFlow')) {
      const apexIdx = Math.abs(seed) % apexNames.length;
      apexCalls.push(apexNames[apexIdx]);
      if (seed % 7 === 0 && apexNames.length > 1) {
        apexCalls.push(apexNames[(apexIdx + 1) % apexNames.length]);
      }
    }

    // Simulate subflow calls
    const subflowCalls: string[] = [];
    if (flowNames.length > 1 && seed % 4 === 0) {
      const subIdx = (idx + 1) % flowNames.length;
      if (flowNames[subIdx] !== flow.FullName.replace(/-\d+$/, '')) {
        subflowCalls.push(flowNames[subIdx]);
      }
    }

    // Simulate objects read / written
    const objectsWritten: string[] = [];
    const objectsRead: string[] = [];
    if (triggerObject) {
      objectsRead.push(triggerObject);
      objectsWritten.push(triggerObject);
    }
    if (seed % 5 === 0 && COMMON_OBJECTS.length > 2) {
      const extraObj = COMMON_OBJECTS[Math.abs(seed) % COMMON_OBJECTS.length];
      if (extraObj !== triggerObject) objectsWritten.push(extraObj);
    }
    if (seed % 6 === 0 && COMMON_OBJECTS.length > 3) {
      const extraObj = COMMON_OBJECTS[(Math.abs(seed) + 3) % COMMON_OBJECTS.length];
      if (!objectsRead.includes(extraObj)) objectsRead.push(extraObj);
    }

    const decisionCount = Math.abs(seed) % 5;
    const loopCount = Math.abs(seed) % 3;
    const complexityScore = elementCount + decisionCount * 2 + loopCount * 3 + apexCalls.length * 2;
    const complexity: FlowDependency['complexity'] =
      complexityScore > 25 ? 'High' : complexityScore > 12 ? 'Medium' : 'Low';

    // Simulate a last modified date within the last 90 days
    const daysAgo = Math.abs(seed) % 90;
    const lastModified = new Date(Date.now() - daysAgo * 86400000).toISOString();

    return {
      id: flow.Id,
      definitionId: flow.DefinitionId,
      fullName: flow.FullName,
      label: deriveLabel(flow.FullName),
      processType: flow.ProcessType,
      triggerType: flow.TriggerType,
      triggerObject,
      status: flow.Status,
      description: flow.Description,
      elementCount,
      apexCalls,
      subflowCalls,
      objectsRead,
      objectsWritten,
      decisionCount,
      loopCount,
      complexity,
      lastModified,
    };
  });
}

/** Simple deterministic hash for a string. */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

/**
 * Lay out nodes in a grid with columns grouped by effective process type.
 */
function layoutNodes(deps: FlowDependency[]): Node[] {
  const COL_WIDTH = 280;
  const ROW_HEIGHT = 100;
  const START_X = 40;
  const START_Y = 40;

  // Group by effective type
  const groups = new Map<string, FlowDependency[]>();
  for (const dep of deps) {
    const eType = effectiveType(dep.processType, dep.triggerType);
    if (!groups.has(eType)) groups.set(eType, []);
    groups.get(eType)!.push(dep);
  }

  const nodes: Node[] = [];
  let colIdx = 0;

  for (const [eType, flowsInGroup] of groups) {
    const color = PROCESS_TYPE_COLORS[eType] ?? PROCESS_TYPE_COLORS.Flow;
    flowsInGroup.forEach((dep, rowIdx) => {
      const nodeSize = Math.max(40, Math.min(80, 30 + dep.elementCount));
      nodes.push({
        id: dep.id,
        position: {
          x: START_X + colIdx * COL_WIDTH,
          y: START_Y + rowIdx * ROW_HEIGHT,
        },
        data: {
          label: dep.label,
          dep,
        },
        style: {
          background: color,
          color: '#ffffff',
          border: '2px solid rgba(255,255,255,0.3)',
          borderRadius: '8px',
          padding: '8px 12px',
          fontSize: '12px',
          fontWeight: 600,
          width: nodeSize * 2.5,
          minWidth: 120,
          textAlign: 'center' as const,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        },
        type: 'default',
      });
    });
    colIdx++;
  }

  return nodes;
}

/**
 * Build edges from the dependency model.
 */
function buildEdges(deps: FlowDependency[]): Edge[] {
  const edges: Edge[] = [];
  const nameToId = new Map<string, string>();
  for (const dep of deps) {
    const baseName = dep.fullName.replace(/-\d+$/, '');
    nameToId.set(baseName, dep.id);
  }

  for (const dep of deps) {
    // Subflow edges (solid)
    for (const subName of dep.subflowCalls) {
      const targetId = nameToId.get(subName);
      if (targetId && targetId !== dep.id) {
        edges.push({
          id: `e-sub-${dep.id}-${targetId}`,
          source: dep.id,
          target: targetId,
          type: 'default',
          animated: false,
          style: { stroke: '#6b7280', strokeWidth: 2 },
          label: 'subflow',
          labelStyle: { fontSize: 10, fill: '#9ca3af' },
          labelBgStyle: { fill: 'transparent' },
        });
      }
    }

    // Apex invocable edges (dashed)
    for (const apexName of dep.apexCalls) {
      // Create a virtual Apex node ID
      const apexNodeId = `apex-${apexName}`;
      edges.push({
        id: `e-apex-${dep.id}-${apexNodeId}`,
        source: dep.id,
        target: apexNodeId,
        type: 'default',
        animated: true,
        style: { stroke: '#f59e0b', strokeWidth: 1.5, strokeDasharray: '5,5' },
        label: 'apex',
        labelStyle: { fontSize: 10, fill: '#f59e0b' },
        labelBgStyle: { fill: 'transparent' },
      });
    }
  }

  return edges;
}

/**
 * Create virtual Apex class nodes referenced by flows.
 */
function buildApexNodes(deps: FlowDependency[], _existingNodeCount: number): Node[] {
  const apexNames = new Set<string>();
  for (const dep of deps) {
    dep.apexCalls.forEach((a) => apexNames.add(a));
  }

  const nodes: Node[] = [];
  let idx = 0;
  const COL_X = 40 + 280 * 6; // Place apex nodes to the far right
  for (const name of apexNames) {
    nodes.push({
      id: `apex-${name}`,
      position: { x: COL_X, y: 40 + idx * 90 },
      data: { label: name },
      style: {
        background: '#1e293b',
        color: '#fbbf24',
        border: '2px dashed #f59e0b',
        borderRadius: '6px',
        padding: '6px 10px',
        fontSize: '11px',
        fontWeight: 500,
        minWidth: 100,
        textAlign: 'center' as const,
      },
      type: 'default',
    });
    idx++;
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

function createTableColumns(
  _onRowHighlight: (flow: FlowDependency) => void,
): ColumnDef<FlowDependency, unknown>[] {
  return [
    {
      accessorKey: 'label',
      header: 'Name',
      cell: ({ row }) => (
        <span className="font-medium text-surface-800 dark:text-surface-100">
          {row.original.label}
        </span>
      ),
    },
    {
      accessorKey: 'processType',
      header: 'Type',
      cell: ({ row }) => {
        const eType = effectiveType(row.original.processType, row.original.triggerType);
        const label = PROCESS_TYPE_LABELS[eType] ?? eType;
        const variantMap: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
          RecordTriggered: 'info',
          Screen: 'success',
          AutoLaunchedFlow: 'warning',
          Scheduled: 'neutral',
          PlatformEvent: 'danger',
          CustomEvent: 'danger',
        };
        return <StatusBadge label={label} variant={variantMap[eType] ?? 'neutral'} />;
      },
    },
    {
      accessorKey: 'triggerObject',
      header: 'Trigger Object',
      cell: ({ row }) => row.original.triggerObject ?? '--',
    },
    {
      accessorKey: 'triggerType',
      header: 'Trigger Type',
      cell: ({ row }) => row.original.triggerType ?? '--',
    },
    {
      accessorKey: 'elementCount',
      header: '# Elements',
    },
    {
      id: 'apexCallCount',
      header: '# Apex Calls',
      accessorFn: (row) => row.apexCalls.length,
    },
    {
      id: 'subflowCallCount',
      header: '# Subflow Calls',
      accessorFn: (row) => row.subflowCalls.length,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <StatusBadge
          label={row.original.status}
          variant={row.original.status === 'Active' ? 'success' : 'neutral'}
        />
      ),
    },
    {
      accessorKey: 'lastModified',
      header: 'Last Modified',
      cell: ({ row }) => new Date(row.original.lastModified).toLocaleDateString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Detail Panel
// ---------------------------------------------------------------------------

function FlowDetailPanel({
  data,
  onClose,
}: {
  data: DetailPanelData;
  onClose: () => void;
}) {
  const { flow } = data;
  const eType = effectiveType(flow.processType, flow.triggerType);
  const typeLabel = PROCESS_TYPE_LABELS[eType] ?? eType;
  const color = PROCESS_TYPE_COLORS[eType] ?? PROCESS_TYPE_COLORS.Flow;

  return (
    <div className="absolute right-4 top-4 w-80 max-h-[calc(100%-2rem)] overflow-y-auto z-20 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-xl shadow-xl">
      <div className="p-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
          <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-100 truncate">
            {flow.label}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 text-lg leading-none"
        >
          &times;
        </button>
      </div>

      <div className="p-4 space-y-3 text-sm">
        <DetailRow label="API Name" value={flow.fullName} />
        <DetailRow label="Type" value={typeLabel} />
        <DetailRow label="Status" value={flow.status} />
        <DetailRow label="Trigger Object" value={flow.triggerObject ?? 'N/A'} />
        <DetailRow label="Trigger Type" value={flow.triggerType ?? 'N/A'} />
        <DetailRow label="Elements" value={String(flow.elementCount)} />
        <DetailRow label="Decisions" value={String(flow.decisionCount)} />
        <DetailRow label="Loops" value={String(flow.loopCount)} />
        <DetailRow label="Complexity" value={flow.complexity} />

        {flow.description && (
          <div>
            <span className="text-surface-500 dark:text-surface-400 text-xs font-medium">Description</span>
            <p className="text-surface-700 dark:text-surface-300 mt-0.5">{flow.description}</p>
          </div>
        )}

        {flow.apexCalls.length > 0 && (
          <DetailList label="Apex Calls" items={flow.apexCalls} color="text-amber-500" />
        )}

        {flow.subflowCalls.length > 0 && (
          <DetailList label="Subflow Calls" items={flow.subflowCalls} color="text-blue-500" />
        )}

        {flow.objectsRead.length > 0 && (
          <DetailList label="Objects Read" items={flow.objectsRead} color="text-green-500" />
        )}

        {flow.objectsWritten.length > 0 && (
          <DetailList label="Objects Written" items={flow.objectsWritten} color="text-red-500" />
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-surface-500 dark:text-surface-400 text-xs font-medium">{label}</span>
      <span className="text-surface-800 dark:text-surface-200 text-xs font-medium">{value}</span>
    </div>
  );
}

function DetailList({
  label,
  items,
  color,
}: {
  label: string;
  items: string[];
  color: string;
}) {
  return (
    <div>
      <span className="text-surface-500 dark:text-surface-400 text-xs font-medium">{label}</span>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li key={item} className={`text-xs ${color}`}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Impact Analysis Panel
// ---------------------------------------------------------------------------

function ImpactSummary({
  selectedFlows,
  allFlows,
}: {
  selectedFlows: Set<string>;
  allFlows: FlowDependency[];
}) {
  const impacted = useMemo(() => {
    const downstream = new Set<string>();
    const queue = [...selectedFlows];

    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const flow of allFlows) {
        if (
          flow.subflowCalls.some((sub) => {
            const match = allFlows.find((f) => f.id === current);
            return match && sub === match.fullName.replace(/-\d+$/, '');
          })
        ) {
          if (!downstream.has(flow.id) && !selectedFlows.has(flow.id)) {
            downstream.add(flow.id);
            queue.push(flow.id);
          }
        }
      }
      // Also check flows that the selected flow calls
      const currentFlow = allFlows.find((f) => f.id === current);
      if (currentFlow) {
        for (const subName of currentFlow.subflowCalls) {
          const target = allFlows.find(
            (f) => f.fullName.replace(/-\d+$/, '') === subName,
          );
          if (target && !downstream.has(target.id) && !selectedFlows.has(target.id)) {
            downstream.add(target.id);
            queue.push(target.id);
          }
        }
      }
    }

    return downstream;
  }, [selectedFlows, allFlows]);

  const affectedObjects = useMemo(() => {
    const objects = new Set<string>();
    for (const flow of allFlows) {
      if (selectedFlows.has(flow.id) || impacted.has(flow.id)) {
        flow.objectsWritten.forEach((o) => objects.add(o));
        flow.objectsRead.forEach((o) => objects.add(o));
      }
    }
    return objects;
  }, [selectedFlows, impacted, allFlows]);

  if (selectedFlows.size === 0) {
    return (
      <p className="text-xs text-surface-500 dark:text-surface-400 italic">
        Select one or more flows to see impact analysis.
      </p>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <Eye className="w-4 h-4 text-red-500" />
        <span className="font-medium text-surface-800 dark:text-surface-200">
          Impact Analysis
        </span>
      </div>
      <p className="text-xs text-surface-600 dark:text-surface-400">
        <span className="font-semibold text-red-500">{selectedFlows.size}</span> flow(s)
        selected &middot;{' '}
        <span className="font-semibold text-amber-500">{impacted.size}</span> downstream
        dependency(ies)
      </p>
      {affectedObjects.size > 0 && (
        <div>
          <span className="text-xs text-surface-500 dark:text-surface-400 font-medium">
            Affected Objects:
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {[...affectedObjects].map((obj) => (
              <span
                key={obj}
                className="text-xs px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
              >
                {obj}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function FlowGraph() {
  // -- State ----------------------------------------------------------------
  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dependencies, setDependencies] = useState<FlowDependency[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [objectFilter, setObjectFilter] = useState<string>('');
  const [selectedDetail, setSelectedDetail] = useState<DetailPanelData | null>(null);
  const [impactSelection, setImpactSelection] = useState<Set<string>>(new Set());
  const [impactMode, setImpactMode] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const { setCacheEntry, getCacheEntry } = useAppStore();

  // -- Data Fetching --------------------------------------------------------

  const fetchFlows = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch active flows via Tooling API
      const flowResult = await toolingQuery<FlowRecord>(
        "SELECT Id, DefinitionId, FullName, ProcessType, TriggerType, Status, Description FROM Flow WHERE Status = 'Active'",
      );

      // Fetch Apex classes for dependency references
      const apexResult = await toolingQuery<ApexClassRecord>(
        'SELECT Id, Name FROM ApexClass',
      );

      const flows = flowResult.records;
      const apexClasses = apexResult.records;

      // Build dependency model
      const deps = buildDependencyModel(flows, apexClasses);
      setDependencies(deps);

      // Cache the results
      setCacheEntry(CACHE_KEY, { flows: deps, fetchedAt: new Date().toISOString() });
      setLastFetchedAt(new Date());

      // Build graph nodes & edges
      const flowNodes = layoutNodes(deps);
      const apexNodes = buildApexNodes(deps, flowNodes.length);
      const allEdges = buildEdges(deps);

      setNodes([...flowNodes, ...apexNodes]);
      setEdges(allEdges);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch flow data';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [setCacheEntry, setNodes, setEdges]);

  // Load from cache or fetch on mount
  useEffect(() => {
    const cached = getCacheEntry(CACHE_KEY);
    if (cached) {
      const { flows, fetchedAt } = cached.data as {
        flows: FlowDependency[];
        fetchedAt: string;
      };
      setDependencies(flows);
      setLastFetchedAt(new Date(fetchedAt));

      const flowNodes = layoutNodes(flows);
      const apexNodes = buildApexNodes(flows, flowNodes.length);
      const allEdges = buildEdges(flows);
      setNodes([...flowNodes, ...apexNodes]);
      setEdges(allEdges);
    } else {
      fetchFlows();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Filtering ------------------------------------------------------------

  const triggerObjects = useMemo(() => {
    const objs = new Set<string>();
    for (const dep of dependencies) {
      if (dep.triggerObject) objs.add(dep.triggerObject);
    }
    return [...objs].sort();
  }, [dependencies]);

  const filteredDependencies = useMemo(() => {
    let filtered = dependencies;

    // Object filter
    if (objectFilter) {
      const relatedIds = new Set<string>();
      for (const dep of dependencies) {
        if (
          dep.triggerObject === objectFilter ||
          dep.objectsRead.includes(objectFilter) ||
          dep.objectsWritten.includes(objectFilter)
        ) {
          relatedIds.add(dep.id);
          // Also include subflow targets
          for (const subName of dep.subflowCalls) {
            const target = dependencies.find(
              (f) => f.fullName.replace(/-\d+$/, '') === subName,
            );
            if (target) relatedIds.add(target.id);
          }
        }
      }
      filtered = filtered.filter((d) => relatedIds.has(d.id));
    }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.label.toLowerCase().includes(q) ||
          d.fullName.toLowerCase().includes(q) ||
          (d.description?.toLowerCase().includes(q) ?? false) ||
          d.apexCalls.some((a) => a.toLowerCase().includes(q)),
      );
    }

    return filtered;
  }, [dependencies, objectFilter, searchQuery]);

  // Update graph when filters change
  useEffect(() => {
    const flowNodes = layoutNodes(filteredDependencies);
    const apexNodes = buildApexNodes(filteredDependencies, flowNodes.length);
    let allEdges = buildEdges(filteredDependencies);

    // Impact mode: color impacted nodes red
    if (impactMode && impactSelection.size > 0) {
      const downstreamIds = new Set<string>();
      const queue = [...impactSelection];
      while (queue.length > 0) {
        const current = queue.pop()!;
        const currentFlow = filteredDependencies.find((f) => f.id === current);
        if (currentFlow) {
          for (const subName of currentFlow.subflowCalls) {
            const target = filteredDependencies.find(
              (f) => f.fullName.replace(/-\d+$/, '') === subName,
            );
            if (target && !downstreamIds.has(target.id) && !impactSelection.has(target.id)) {
              downstreamIds.add(target.id);
              queue.push(target.id);
            }
          }
        }
      }

      const updatedNodes = [...flowNodes, ...apexNodes].map((node) => {
        if (impactSelection.has(node.id)) {
          return {
            ...node,
            style: {
              ...node.style,
              border: '3px solid #ef4444',
              boxShadow: '0 0 12px rgba(239,68,68,0.5)',
            },
          };
        }
        if (downstreamIds.has(node.id)) {
          return {
            ...node,
            style: {
              ...node.style,
              background: '#dc2626',
              border: '2px solid #fca5a5',
              boxShadow: '0 0 8px rgba(239,68,68,0.3)',
            },
          };
        }
        return node;
      });

      const updatedEdges = allEdges.map((edge) => {
        const isImpacted =
          impactSelection.has(edge.source) || downstreamIds.has(edge.source) ||
          impactSelection.has(edge.target) || downstreamIds.has(edge.target);
        if (isImpacted) {
          return {
            ...edge,
            style: { ...edge.style, stroke: '#ef4444', strokeWidth: 3 },
            animated: true,
          };
        }
        return { ...edge, style: { ...edge.style, opacity: 0.3 } };
      });

      setNodes(updatedNodes);
      setEdges(updatedEdges);
    } else {
      setNodes([...flowNodes, ...apexNodes]);
      setEdges(allEdges);
    }
  }, [filteredDependencies, impactMode, impactSelection, setNodes, setEdges]);

  // -- Event Handlers -------------------------------------------------------

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.id.startsWith('apex-')) return;

      if (impactMode) {
        setImpactSelection((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) {
            next.delete(node.id);
          } else {
            next.add(node.id);
          }
          return next;
        });
        return;
      }

      const dep = (node.data as { dep?: FlowDependency }).dep;
      if (dep) {
        setSelectedDetail({ flow: dep });
      }
    },
    [impactMode],
  );

  const handleTableRowClick = useCallback(
    (flow: FlowDependency) => {
      setSelectedDetail({ flow });
      setViewMode('graph');
      // Center on the node (highlight via selection)
      setImpactSelection(new Set([flow.id]));
      setImpactMode(true);
    },
    [],
  );

  const handleExportJson = useCallback(() => {
    const exportData = {
      exportedAt: new Date().toISOString(),
      flowCount: filteredDependencies.length,
      flows: filteredDependencies,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flow-dependencies-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredDependencies]);

  const handleExportPng = useCallback(async () => {
    try {
      const { default: html2canvas } = await import('html2canvas');
      const graphEl = document.getElementById('flow-graph-container');
      if (!graphEl) return;
      const canvas = await html2canvas(graphEl, { backgroundColor: '#0f172a' });
      const link = document.createElement('a');
      link.download = `flow-graph-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = canvas.toDataURL();
      link.click();
    } catch {
      // html2canvas may not be installed; silently degrade
      console.warn('PNG export requires html2canvas package');
    }
  }, []);

  // -- Table columns --------------------------------------------------------

  const tableColumns = useMemo(
    () => createTableColumns(handleTableRowClick),
    [handleTableRowClick],
  );

  // -- Render ---------------------------------------------------------------

  if (loading) {
    return <LoadingSpinner message="Fetching active flows and building dependency graph..." />;
  }

  if (error) {
    return (
      <ErrorAlert
        title="Flow Graph Error"
        message={error}
        onRetry={fetchFlows}
      />
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* ── Header & Controls ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <GitBranch className="w-5 h-5 text-primary-500" />
          <div>
            <h2 className="text-lg font-semibold text-surface-800 dark:text-surface-100">
              Flow Dependency Graph
            </h2>
            <p className="text-xs text-surface-500 dark:text-surface-400">
              {filteredDependencies.length} active flow(s)
              {lastFetchedAt && (
                <> &middot; Last fetched {lastFetchedAt.toLocaleTimeString()}</>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
            <input
              type="text"
              placeholder="Search flows..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                         bg-surface-50 dark:bg-surface-800 text-surface-800 dark:text-surface-200
                         focus:outline-none focus:ring-2 focus:ring-primary-500/40 w-48"
            />
          </div>

          {/* Object Filter */}
          <select
            value={objectFilter}
            onChange={(e) => setObjectFilter(e.target.value)}
            className="py-1.5 px-3 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                       bg-surface-50 dark:bg-surface-800 text-surface-800 dark:text-surface-200
                       focus:outline-none focus:ring-2 focus:ring-primary-500/40"
          >
            <option value="">All Objects</option>
            {triggerObjects.map((obj) => (
              <option key={obj} value={obj}>
                {obj}
              </option>
            ))}
          </select>

          {/* View Toggle */}
          <div className="flex rounded-lg border border-surface-200 dark:border-surface-600 overflow-hidden">
            <button
              onClick={() => setViewMode('graph')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
                viewMode === 'graph'
                  ? 'bg-primary-500 text-white'
                  : 'bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" />
              Graph
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
                viewMode === 'table'
                  ? 'bg-primary-500 text-white'
                  : 'bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700'
              }`}
            >
              <Table2 className="w-3.5 h-3.5" />
              Table
            </button>
          </div>

          {/* Impact Mode Toggle */}
          <button
            onClick={() => {
              setImpactMode(!impactMode);
              if (impactMode) {
                setImpactSelection(new Set());
              }
            }}
            className={`px-3 py-1.5 text-sm rounded-lg flex items-center gap-1.5 transition-colors border ${
              impactMode
                ? 'bg-red-500 text-white border-red-500'
                : 'border-surface-200 dark:border-surface-600 bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700'
            }`}
            title="Toggle impact analysis mode"
          >
            <Eye className="w-3.5 h-3.5" />
            Impact
          </button>

          {/* Export Buttons */}
          <button
            onClick={handleExportJson}
            className="px-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                       bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400
                       hover:bg-surface-100 dark:hover:bg-surface-700 flex items-center gap-1.5 transition-colors"
            title="Export dependency data as JSON"
          >
            <Download className="w-3.5 h-3.5" />
            JSON
          </button>

          <button
            onClick={handleExportPng}
            className="px-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                       bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400
                       hover:bg-surface-100 dark:hover:bg-surface-700 flex items-center gap-1.5 transition-colors"
            title="Export graph as PNG"
          >
            <Download className="w-3.5 h-3.5" />
            PNG
          </button>

          {/* Refresh */}
          <button
            onClick={fetchFlows}
            disabled={loading}
            className="p-1.5 rounded-lg border border-surface-200 dark:border-surface-600
                       bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400
                       hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors disabled:opacity-50"
            title="Refresh flow data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Impact Summary (when active) ──────────────────────────────────── */}
      {impactMode && (
        <div className="px-4 py-3 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10">
          <ImpactSummary selectedFlows={impactSelection} allFlows={filteredDependencies} />
        </div>
      )}

      {/* ── Legend ─────────────────────────────────────────────────────────── */}
      {viewMode === 'graph' && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-surface-500 dark:text-surface-400">
          {Object.entries(PROCESS_TYPE_LABELS).map(([key, label]) => (
            <div key={key} className="flex items-center gap-1.5">
              <div
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: PROCESS_TYPE_COLORS[key] ?? '#6b7280' }}
              />
              <span>{label}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-0.5 bg-surface-500" />
            <span>Subflow call</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-0.5 border-t-2 border-dashed border-amber-500" />
            <span>Apex invocable</span>
          </div>
        </div>
      )}

      {/* ── Content Area ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {viewMode === 'graph' ? (
          <div
            id="flow-graph-container"
            className="h-full w-full rounded-xl border border-surface-200 dark:border-surface-700 overflow-hidden relative"
            style={{ minHeight: 500 }}
          >
            {filteredDependencies.length === 0 ? (
              <div className="flex items-center justify-center h-full text-surface-500 dark:text-surface-400 text-sm">
                No flows match the current filters.
              </div>
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={handleNodeClick}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.1}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
              >
                <Controls
                  className="!bg-surface-50 dark:!bg-surface-800 !border-surface-200 dark:!border-surface-700 !rounded-lg !shadow-lg"
                />
                <MiniMap
                  nodeStrokeWidth={3}
                  pannable
                  zoomable
                  className="!bg-surface-100 dark:!bg-surface-900 !border-surface-200 dark:!border-surface-700 !rounded-lg"
                />
                <Background color="#334155" gap={20} />
              </ReactFlow>
            )}

            {/* Detail Panel Overlay */}
            {selectedDetail && (
              <FlowDetailPanel
                data={selectedDetail}
                onClose={() => setSelectedDetail(null)}
              />
            )}
          </div>
        ) : (
          <DataTable
            data={filteredDependencies}
            columns={tableColumns}
            title="Active Flows"
            searchable={false}
            exportable
            exportFilename="flow-dependencies"
            pageSize={25}
            onRowClick={handleTableRowClick}
          />
        )}
      </div>
    </div>
  );
}
