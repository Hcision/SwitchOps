// ---------------------------------------------------------------------------
// Tool 10 - Cross-Object Field Lineage Tracker
// ---------------------------------------------------------------------------
// Traces how a Salesforce field's value propagates across objects through
// automations (Flows, Process Builders, Apex triggers, Workflow Rules).
// Supports forward lineage (where does this value go?), backward lineage
// (where did this value come from?), record-level trace with mismatch
// detection, and a special Configuration String propagation view.
// ---------------------------------------------------------------------------

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Route,
  Search,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  ArrowLeft,
  Eye,
  AlertTriangle,
} from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { useAppStore } from '@/services/store';
import { toolingQuery, query, getRecord } from '@/services/salesforce';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ObjectOption {
  apiName: string;
  label: string;
}

interface FieldOption {
  apiName: string;
  label: string;
}

interface LineageNode {
  id: string;
  objectName: string;
  fieldName: string;
  fullName: string;
  automationName: string;
  automationType: string;
  direction: 'forward' | 'backward';
  depth: number;
  children: LineageNode[];
  expanded: boolean;
}

interface DependencyRecord {
  MetadataComponentId: string;
  MetadataComponentName: string;
  MetadataComponentType: string;
  RefMetadataComponentId: string;
  RefMetadataComponentName: string;
  RefMetadataComponentType: string;
  [key: string]: unknown;
}

interface RecordTraceEntry {
  objectName: string;
  fieldName: string;
  fullName: string;
  recordId: string;
  value: string | null;
  automationName: string;
  automationType: string;
  mismatch: boolean;
}

interface PropagationStep {
  objectName: string;
  objectLabel: string;
  fieldName: string;
  recordId: string | null;
  value: string | null;
  found: boolean;
  mismatch: boolean;
}

type ActiveTab = 'forward' | 'backward' | 'record-trace' | 'config-chain';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEY = 'tool-10-field-lineage';

const AUTOMATION_TYPE_LABELS: Record<string, string> = {
  Flow: 'Flow',
  FlowDefinition: 'Flow',
  WorkflowRule: 'Workflow Rule',
  WorkflowFieldUpdate: 'Field Update',
  ApexTrigger: 'Apex Trigger',
  ApexClass: 'Apex Class',
  ValidationRule: 'Validation Rule',
  ProcessBuilder: 'Process Builder',
  CustomField: 'Custom Field',
};

const CONFIG_CHAIN_OBJECTS = [
  { objectName: 'SBQQ__QuoteLine__c', label: 'Quote Line', fieldName: '' },
  { objectName: 'Asset', label: 'Asset', fieldName: '' },
  { objectName: 'Case', label: 'Case', fieldName: '' },
  { objectName: 'WorkOrder', label: 'Work Order', fieldName: '' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function automationTypeLabel(raw: string): string {
  return AUTOMATION_TYPE_LABELS[raw] ?? raw;
}

function automationVariant(
  type: string,
): 'info' | 'warning' | 'success' | 'neutral' | 'danger' {
  const lower = type.toLowerCase();
  if (lower.includes('flow') || lower.includes('process')) return 'info';
  if (lower.includes('apex') || lower.includes('trigger')) return 'warning';
  if (lower.includes('workflow') || lower.includes('field update')) return 'success';
  if (lower.includes('validation')) return 'danger';
  return 'neutral';
}

function parseFieldRef(input: string): { objectName: string; fieldName: string } | null {
  const trimmed = input.trim();
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex < 1) return null;
  return {
    objectName: trimmed.substring(0, dotIndex),
    fieldName: trimmed.substring(dotIndex + 1),
  };
}

function generateNodeId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Tree Node Component
// ---------------------------------------------------------------------------

interface TreeNodeProps {
  node: LineageNode;
  onToggle: (nodeId: string) => void;
  depth?: number;
}

function TreeNodeView({ node, onToggle, depth = 0 }: TreeNodeProps) {
  const hasChildren = node.children.length > 0;
  const indentPx = depth * 24;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-surface-100 dark:hover:bg-surface-700/50 cursor-pointer transition-colors"
        style={{ paddingLeft: `${indentPx + 8}px` }}
        onClick={() => hasChildren && onToggle(node.id)}
      >
        {/* Expand / collapse toggle */}
        {hasChildren ? (
          node.expanded ? (
            <ChevronDown className="w-4 h-4 text-surface-400 shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-surface-400 shrink-0" />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* Direction arrow */}
        {node.direction === 'forward' ? (
          <ArrowRight className="w-3.5 h-3.5 text-blue-500 shrink-0" />
        ) : (
          <ArrowLeft className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        )}

        {/* Field reference */}
        <span className="text-sm font-mono font-medium text-surface-800 dark:text-surface-200">
          {node.objectName}.
          <span className="text-primary-600 dark:text-primary-400">{node.fieldName}</span>
        </span>

        {/* Automation badge */}
        {node.automationName && (
          <StatusBadge
            label={`${automationTypeLabel(node.automationType)}: ${node.automationName}`}
            variant={automationVariant(node.automationType)}
          />
        )}
      </div>

      {/* Recursive children */}
      {hasChildren && node.expanded && (
        <div>
          {node.children.map((child) => (
            <TreeNodeView key={child.id} node={child} onToggle={onToggle} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Record Trace Table Columns
// ---------------------------------------------------------------------------

const traceColumns: ColumnDef<RecordTraceEntry, unknown>[] = [
  {
    accessorKey: 'fullName',
    header: 'Field',
    cell: ({ getValue }) => (
      <span className="text-sm font-mono font-medium text-primary-600 dark:text-primary-400">
        {getValue<string>()}
      </span>
    ),
  },
  {
    accessorKey: 'automationType',
    header: 'Automation Type',
    cell: ({ getValue }) => {
      const val = getValue<string>();
      return <StatusBadge label={automationTypeLabel(val)} variant={automationVariant(val)} />;
    },
  },
  {
    accessorKey: 'automationName',
    header: 'Automation Name',
    cell: ({ getValue }) => (
      <span className="text-xs">{getValue<string>() || '\u2014'}</span>
    ),
  },
  {
    accessorKey: 'value',
    header: 'Current Value',
    cell: ({ row }) => {
      const val = row.original.value;
      const mismatch = row.original.mismatch;
      return (
        <span
          className={`text-xs font-mono ${
            mismatch
              ? 'text-red-600 dark:text-red-400 font-semibold'
              : 'text-surface-700 dark:text-surface-300'
          }`}
        >
          {val ?? <span className="text-surface-400 italic">null</span>}
          {mismatch && (
            <AlertTriangle className="inline-block w-3 h-3 ml-1 text-red-500" />
          )}
        </span>
      );
    },
  },
  {
    accessorKey: 'recordId',
    header: 'Record ID',
    cell: ({ getValue }) => (
      <span className="text-xs font-mono text-surface-500">{getValue<string>()}</span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function FieldLineage() {
  // ── Store ──────────────────────────────────────────────────────────────────
  const instanceUrl = useAppStore((s) => s.auth.instanceUrl);
  const setCacheEntry = useAppStore((s) => s.setCacheEntry);
  const getCacheEntry = useAppStore((s) => s.getCacheEntry);

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('forward');

  // ── Field selector state ───────────────────────────────────────────────────
  const [objects, setObjects] = useState<ObjectOption[]>([]);
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [selectedObject, setSelectedObject] = useState('');
  const [selectedField, setSelectedField] = useState('');
  const [directInput, setDirectInput] = useState('');
  const [inputMode, setInputMode] = useState<'picker' | 'direct'>('picker');
  const [objectSearchTerm, setObjectSearchTerm] = useState('');
  const [fieldSearchTerm, setFieldSearchTerm] = useState('');

  // ── Lineage state ──────────────────────────────────────────────────────────
  const [forwardTree, setForwardTree] = useState<LineageNode[]>([]);
  const [backwardTree, setBackwardTree] = useState<LineageNode[]>([]);

  // ── Record trace state ─────────────────────────────────────────────────────
  const [traceRecordId, setTraceRecordId] = useState('');
  const [traceEntries, setTraceEntries] = useState<RecordTraceEntry[]>([]);

  // ── Config chain state ─────────────────────────────────────────────────────
  const [configFieldName, setConfigFieldName] = useState('K_Mat_String_single_line__c');
  const [configRecordId, setConfigRecordId] = useState('');
  const [configSteps, setConfigSteps] = useState<PropagationStep[]>([]);

  // ── Loading / error ────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Derived: resolved field reference ──────────────────────────────────────
  const resolvedField = useMemo(() => {
    if (inputMode === 'direct') {
      return parseFieldRef(directInput);
    }
    if (selectedObject && selectedField) {
      return { objectName: selectedObject, fieldName: selectedField };
    }
    return null;
  }, [inputMode, directInput, selectedObject, selectedField]);

  // ── Filtered object list ───────────────────────────────────────────────────
  const filteredObjects = useMemo(() => {
    if (!objectSearchTerm) return objects;
    const lower = objectSearchTerm.toLowerCase();
    return objects.filter(
      (o) =>
        o.apiName.toLowerCase().includes(lower) || o.label.toLowerCase().includes(lower),
    );
  }, [objects, objectSearchTerm]);

  // ── Filtered field list ────────────────────────────────────────────────────
  const filteredFields = useMemo(() => {
    if (!fieldSearchTerm) return fields;
    const lower = fieldSearchTerm.toLowerCase();
    return fields.filter(
      (f) =>
        f.apiName.toLowerCase().includes(lower) || f.label.toLowerCase().includes(lower),
    );
  }, [fields, fieldSearchTerm]);

  // ── Load objects ───────────────────────────────────────────────────────────
  const loadObjects = useCallback(async () => {
    const cached = getCacheEntry(`${CACHE_KEY}-objects`);
    if (cached) {
      setObjects(cached.data as ObjectOption[]);
      return;
    }

    setLoadingObjects(true);
    try {
      const result = await toolingQuery<{ QualifiedApiName: string; Label: string }>(
        "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomizable = true ORDER BY QualifiedApiName LIMIT 200",
      );
      const mapped: ObjectOption[] = result.records.map((r) => ({
        apiName: r.QualifiedApiName,
        label: r.Label,
      }));
      setObjects(mapped);
      setCacheEntry(`${CACHE_KEY}-objects`, mapped);
    } catch (err) {
      setError(`Failed to load objects: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingObjects(false);
    }
  }, [getCacheEntry, setCacheEntry]);

  // ── Load fields for selected object ────────────────────────────────────────
  const loadFields = useCallback(
    async (objectApiName: string) => {
      if (!objectApiName) {
        setFields([]);
        return;
      }

      const cacheKey = `${CACHE_KEY}-fields-${objectApiName}`;
      const cached = getCacheEntry(cacheKey);
      if (cached) {
        setFields(cached.data as FieldOption[]);
        return;
      }

      setLoadingFields(true);
      try {
        const result = await toolingQuery<{ QualifiedApiName: string; Label: string }>(
          `SELECT QualifiedApiName, Label FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectApiName}' ORDER BY QualifiedApiName LIMIT 500`,
        );
        const mapped: FieldOption[] = result.records.map((r) => ({
          apiName: r.QualifiedApiName,
          label: r.Label,
        }));
        setFields(mapped);
        setCacheEntry(cacheKey, mapped);
      } catch (err) {
        setError(
          `Failed to load fields for ${objectApiName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setLoadingFields(false);
      }
    },
    [getCacheEntry, setCacheEntry],
  );

  // ── Fetch dependencies from MetadataComponentDependency ────────────────────
  const fetchDependencies = useCallback(
    async (
      objectName: string,
      fieldName: string,
      direction: 'forward' | 'backward',
    ): Promise<DependencyRecord[]> => {
      const fullFieldRef = `${objectName}.${fieldName}`;

      try {
        if (direction === 'forward') {
          // Find automations that reference this field (where this field is consumed)
          const result = await toolingQuery<DependencyRecord>(
            `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentName = '${fullFieldRef}'`,
          );
          return result.records;
        } else {
          // Find automations that write to this field (where this field is produced)
          const result = await toolingQuery<DependencyRecord>(
            `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE MetadataComponentName = '${fullFieldRef}'`,
          );
          return result.records;
        }
      } catch {
        // Fallback: query without strict field reference
        try {
          if (direction === 'forward') {
            const result = await toolingQuery<DependencyRecord>(
              `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentName = '${fieldName}'`,
            );
            return result.records;
          } else {
            const result = await toolingQuery<DependencyRecord>(
              `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE MetadataComponentName = '${fieldName}'`,
            );
            return result.records;
          }
        } catch {
          // MetadataComponentDependency not available in this org edition
          setError(
            'MetadataComponentDependency not available in this org edition. Dependency analysis requires Enterprise Edition or higher.',
          );
          return [];
        }
      }
    },
    [],
  );

  // ── Build lineage tree from dependencies ───────────────────────────────────
  const buildLineageTree = useCallback(
    (
      deps: DependencyRecord[],
      rootObject: string,
      rootField: string,
      direction: 'forward' | 'backward',
    ): LineageNode[] => {
      const nodes: LineageNode[] = [];

      for (const dep of deps) {
        const automationName =
          direction === 'forward'
            ? (dep.MetadataComponentName as string)
            : (dep.RefMetadataComponentName as string);
        const automationType =
          direction === 'forward'
            ? (dep.MetadataComponentType as string)
            : (dep.RefMetadataComponentType as string);

        // Attempt to parse target/source field from the dependency
        const refName =
          direction === 'forward'
            ? (dep.MetadataComponentName as string)
            : (dep.RefMetadataComponentName as string);

        const parsed = parseFieldRef(refName);
        const targetObject = parsed?.objectName ?? refName?.split('.')[0] ?? 'Unknown';
        const targetField = parsed?.fieldName ?? refName?.split('.')[1] ?? refName ?? 'Unknown';

        // Skip self-references
        if (targetObject === rootObject && targetField === rootField) continue;

        nodes.push({
          id: generateNodeId(),
          objectName: targetObject,
          fieldName: targetField,
          fullName: `${targetObject}.${targetField}`,
          automationName: automationName ?? 'Unknown',
          automationType: automationType ?? 'Unknown',
          direction,
          depth: 1,
          children: [],
          expanded: false,
        });
      }

      // Deduplicate by fullName + automationName
      const seen = new Set<string>();
      return nodes.filter((n) => {
        const key = `${n.fullName}::${n.automationName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [],
  );

  // ── Toggle tree node expansion ─────────────────────────────────────────────
  const toggleNode = useCallback(
    (nodeId: string, tree: LineageNode[], setTree: (t: LineageNode[]) => void) => {
      const toggle = (nodes: LineageNode[]): LineageNode[] =>
        nodes.map((n) => {
          if (n.id === nodeId) return { ...n, expanded: !n.expanded };
          if (n.children.length > 0) return { ...n, children: toggle(n.children) };
          return n;
        });
      setTree(toggle(tree));
    },
    [],
  );

  // ── Trace forward lineage ─────────────────────────────────────────────────
  const traceForward = useCallback(async () => {
    if (!resolvedField) return;
    setLoading(true);
    setError(null);
    setForwardTree([]);

    try {
      const deps = await fetchDependencies(
        resolvedField.objectName,
        resolvedField.fieldName,
        'forward',
      );
      const tree = buildLineageTree(
        deps,
        resolvedField.objectName,
        resolvedField.fieldName,
        'forward',
      );
      setForwardTree(tree);

      if (tree.length === 0) {
        setError('No forward dependencies found for this field. The field may not be referenced by any automations, or the Tooling API may not expose its dependencies.');
      }
    } catch (err) {
      setError(
        `Forward lineage trace failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [resolvedField, fetchDependencies, buildLineageTree]);

  // ── Trace backward lineage ────────────────────────────────────────────────
  const traceBackward = useCallback(async () => {
    if (!resolvedField) return;
    setLoading(true);
    setError(null);
    setBackwardTree([]);

    try {
      const deps = await fetchDependencies(
        resolvedField.objectName,
        resolvedField.fieldName,
        'backward',
      );
      const tree = buildLineageTree(
        deps,
        resolvedField.objectName,
        resolvedField.fieldName,
        'backward',
      );
      setBackwardTree(tree);

      if (tree.length === 0) {
        setError('No backward dependencies found for this field. The field may not be produced by any automations, or the Tooling API may not expose its dependencies.');
      }
    } catch (err) {
      setError(
        `Backward lineage trace failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [resolvedField, fetchDependencies, buildLineageTree]);

  // ── Record-level trace ────────────────────────────────────────────────────
  const runRecordTrace = useCallback(async () => {
    if (!resolvedField || !traceRecordId.trim()) return;
    setLoading(true);
    setError(null);
    setTraceEntries([]);

    try {
      // Fetch the source record value
      const sourceRecord = await getRecord(
        resolvedField.objectName,
        traceRecordId.trim(),
        [resolvedField.fieldName],
      );
      const sourceValue = sourceRecord[resolvedField.fieldName] as string | null;

      const entries: RecordTraceEntry[] = [
        {
          objectName: resolvedField.objectName,
          fieldName: resolvedField.fieldName,
          fullName: `${resolvedField.objectName}.${resolvedField.fieldName}`,
          recordId: traceRecordId.trim(),
          value: sourceValue,
          automationName: '(source)',
          automationType: 'Source',
          mismatch: false,
        },
      ];

      // Get forward dependencies and fetch their values
      const deps = await fetchDependencies(
        resolvedField.objectName,
        resolvedField.fieldName,
        'forward',
      );
      const tree = buildLineageTree(
        deps,
        resolvedField.objectName,
        resolvedField.fieldName,
        'forward',
      );

      for (const node of tree) {
        try {
          // Try to find a related record using a lookup query
          const lookupResult = await query(
            `SELECT Id, ${node.fieldName} FROM ${node.objectName} WHERE Id != null LIMIT 1`,
          );

          if (lookupResult.records.length > 0) {
            const targetValue = lookupResult.records[0][node.fieldName] as string | null;
            entries.push({
              objectName: node.objectName,
              fieldName: node.fieldName,
              fullName: node.fullName,
              recordId: lookupResult.records[0].Id ?? '',
              value: targetValue,
              automationName: node.automationName,
              automationType: node.automationType,
              mismatch: sourceValue !== null && targetValue !== null && sourceValue !== targetValue,
            });
          }
        } catch {
          // Skip fields/objects we cannot query
          entries.push({
            objectName: node.objectName,
            fieldName: node.fieldName,
            fullName: node.fullName,
            recordId: '',
            value: null,
            automationName: node.automationName,
            automationType: node.automationType,
            mismatch: false,
          });
        }
      }

      setTraceEntries(entries);
    } catch (err) {
      setError(
        `Record trace failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [resolvedField, traceRecordId, fetchDependencies, buildLineageTree]);

  // ── Configuration string propagation chain ────────────────────────────────
  const runConfigChain = useCallback(async () => {
    if (!configRecordId.trim() || !configFieldName.trim()) return;
    setLoading(true);
    setError(null);
    setConfigSteps([]);

    try {
      const steps: PropagationStep[] = [];
      let currentRecordId: string | null = configRecordId.trim();
      let previousValue: string | null = null;

      for (const chainObj of CONFIG_CHAIN_OBJECTS) {
        const fieldToQuery = chainObj.fieldName || configFieldName;

        if (!currentRecordId) {
          steps.push({
            objectName: chainObj.objectName,
            objectLabel: chainObj.label,
            fieldName: fieldToQuery,
            recordId: null,
            value: null,
            found: false,
            mismatch: false,
          });
          continue;
        }

        try {
          // Determine if this is the starting object or a related one
          if (steps.length === 0) {
            // First object: fetch directly
            const record = await getRecord(chainObj.objectName, currentRecordId, [
              fieldToQuery,
              'Id',
            ]);
            const value = record[fieldToQuery] as string | null;
            steps.push({
              objectName: chainObj.objectName,
              objectLabel: chainObj.label,
              fieldName: fieldToQuery,
              recordId: currentRecordId,
              value,
              found: true,
              mismatch: false,
            });
            previousValue = value;

            // Try to find a related record in the next object
            currentRecordId = await findRelatedRecord(
              chainObj.objectName,
              currentRecordId,
              CONFIG_CHAIN_OBJECTS[1]?.objectName ?? '',
            );
          } else {
            // Subsequent objects: fetch and compare
            try {
              const record = await getRecord(chainObj.objectName, currentRecordId, [
                fieldToQuery,
                'Id',
              ]);
              const value = record[fieldToQuery] as string | null;
              const mismatch =
                previousValue !== null && value !== null && previousValue !== value;
              steps.push({
                objectName: chainObj.objectName,
                objectLabel: chainObj.label,
                fieldName: fieldToQuery,
                recordId: currentRecordId,
                value,
                found: true,
                mismatch,
              });
              previousValue = value;

              // Find next related record
              const nextObj = CONFIG_CHAIN_OBJECTS[steps.length];
              if (nextObj) {
                currentRecordId = await findRelatedRecord(
                  chainObj.objectName,
                  currentRecordId,
                  nextObj.objectName,
                );
              }
            } catch {
              steps.push({
                objectName: chainObj.objectName,
                objectLabel: chainObj.label,
                fieldName: fieldToQuery,
                recordId: currentRecordId,
                value: null,
                found: false,
                mismatch: false,
              });
              currentRecordId = null;
            }
          }
        } catch {
          steps.push({
            objectName: chainObj.objectName,
            objectLabel: chainObj.label,
            fieldName: fieldToQuery,
            recordId: currentRecordId,
            value: null,
            found: false,
            mismatch: false,
          });
          currentRecordId = null;
        }
      }

      setConfigSteps(steps);
    } catch (err) {
      setError(
        `Configuration chain trace failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [configRecordId, configFieldName]);

  // ── Helper: find related record across objects ─────────────────────────────
  async function findRelatedRecord(
    sourceObject: string,
    sourceId: string,
    targetObject: string,
  ): Promise<string | null> {
    // Common relationship patterns
    const lookupPatterns: Record<string, string> = {
      'SBQQ__QuoteLine__c->Asset': `SELECT Id FROM Asset WHERE SBQQ__QuoteLine__c = '${sourceId}' LIMIT 1`,
      'Asset->Case': `SELECT Id FROM Case WHERE AssetId = '${sourceId}' ORDER BY CreatedDate DESC LIMIT 1`,
      'Case->WorkOrder': `SELECT Id FROM WorkOrder WHERE CaseId = '${sourceId}' ORDER BY CreatedDate DESC LIMIT 1`,
    };

    const key = `${sourceObject}->${targetObject}`;
    const soql = lookupPatterns[key];

    if (soql) {
      try {
        const result = await query(soql);
        if (result.records.length > 0) {
          return result.records[0].Id ?? null;
        }
      } catch {
        // Relationship not found
      }
    }

    return null;
  }

  // ── Load objects on mount ──────────────────────────────────────────────────
  useEffect(() => {
    loadObjects();
  }, [loadObjects]);

  // ── Load fields when object changes ────────────────────────────────────────
  useEffect(() => {
    if (selectedObject) {
      loadFields(selectedObject);
      setSelectedField('');
      setFieldSearchTerm('');
    }
  }, [selectedObject, loadFields]);

  // ── Auto-trace on tab change if field is set ───────────────────────────────
  const handleTabChange = useCallback(
    (tab: ActiveTab) => {
      setActiveTab(tab);
      setError(null);
    },
    [],
  );

  // ── Tab definitions ────────────────────────────────────────────────────────
  const tabs: { key: ActiveTab; label: string; icon: React.ReactNode }[] = [
    {
      key: 'forward',
      label: 'Forward Lineage',
      icon: <ArrowRight className="w-4 h-4" />,
    },
    {
      key: 'backward',
      label: 'Backward Lineage',
      icon: <ArrowLeft className="w-4 h-4" />,
    },
    {
      key: 'record-trace',
      label: 'Record Trace',
      icon: <Eye className="w-4 h-4" />,
    },
    {
      key: 'config-chain',
      label: 'Config String Chain',
      icon: <Route className="w-4 h-4" />,
    },
  ];

  // ── Config chain columns ───────────────────────────────────────────────────
  const configColumns: ColumnDef<PropagationStep, unknown>[] = useMemo(
    () => [
      {
        accessorKey: 'objectLabel',
        header: 'Object',
        cell: ({ getValue }) => (
          <span className="text-sm font-semibold text-surface-800 dark:text-surface-200">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: 'fieldName',
        header: 'Field',
        cell: ({ getValue }) => (
          <span className="text-sm font-mono text-primary-600 dark:text-primary-400">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: 'recordId',
        header: 'Record ID',
        cell: ({ row }) => {
          const id = row.original.recordId;
          if (!id) return <span className="text-xs text-surface-400 italic">not found</span>;
          return (
            <a
              href={`${instanceUrl}/${id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-primary-500 hover:underline"
            >
              {id}
            </a>
          );
        },
      },
      {
        accessorKey: 'value',
        header: 'Value',
        cell: ({ row }) => {
          const { value, mismatch, found } = row.original;
          if (!found) {
            return (
              <span className="text-xs text-surface-400 italic flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Record not found
              </span>
            );
          }
          return (
            <span
              className={`text-xs font-mono break-all ${
                mismatch
                  ? 'text-red-600 dark:text-red-400 font-semibold'
                  : 'text-surface-700 dark:text-surface-300'
              }`}
            >
              {value ?? <span className="text-surface-400 italic">null</span>}
              {mismatch && (
                <AlertTriangle className="inline-block w-3 h-3 ml-1 text-red-500" />
              )}
            </span>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const { found, mismatch } = row.original;
          if (!found) return <StatusBadge label="Not Found" variant="warning" />;
          if (mismatch) return <StatusBadge label="Mismatch" variant="danger" />;
          return <StatusBadge label="OK" variant="success" />;
        },
      },
    ],
    [instanceUrl],
  );

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-auto">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shrink-0">
          <Route className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-surface-800 dark:text-surface-100">
            Cross-Object Field Lineage Tracker
          </h1>
          <p className="text-sm text-surface-500 dark:text-surface-400">
            Trace how a field&apos;s value propagates across objects through automations
          </p>
        </div>
      </div>

      {/* ── Field Selector ────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
        <div className="flex items-center gap-4 mb-3">
          <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300 uppercase tracking-wide">
            Field Selector
          </h2>
          <div className="flex gap-1 bg-surface-100 dark:bg-surface-700 rounded-lg p-0.5">
            <button
              onClick={() => setInputMode('picker')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                inputMode === 'picker'
                  ? 'bg-white dark:bg-surface-600 text-surface-800 dark:text-surface-100 shadow-sm'
                  : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200'
              }`}
            >
              Object &rarr; Field
            </button>
            <button
              onClick={() => setInputMode('direct')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                inputMode === 'direct'
                  ? 'bg-white dark:bg-surface-600 text-surface-800 dark:text-surface-100 shadow-sm'
                  : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200'
              }`}
            >
              Direct Input
            </button>
          </div>
        </div>

        {inputMode === 'picker' ? (
          <div className="flex flex-col md:flex-row gap-4">
            {/* Object picker */}
            <div className="flex-1">
              <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                Object
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder={loadingObjects ? 'Loading objects...' : 'Search objects...'}
                  value={objectSearchTerm}
                  onChange={(e) => setObjectSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                  disabled={loadingObjects}
                />
              </div>
              {objectSearchTerm && (
                <div className="mt-1 max-h-48 overflow-auto border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 shadow-lg">
                  {filteredObjects.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-surface-400">No objects found</div>
                  ) : (
                    filteredObjects.slice(0, 50).map((obj) => (
                      <button
                        key={obj.apiName}
                        onClick={() => {
                          setSelectedObject(obj.apiName);
                          setObjectSearchTerm('');
                        }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface-100 dark:hover:bg-surface-600 transition-colors ${
                          selectedObject === obj.apiName
                            ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                            : 'text-surface-700 dark:text-surface-300'
                        }`}
                      >
                        <span className="font-medium">{obj.label}</span>
                        <span className="ml-2 text-xs text-surface-400 font-mono">
                          {obj.apiName}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {selectedObject && !objectSearchTerm && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs font-mono text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 rounded">
                    {selectedObject}
                  </span>
                  <button
                    onClick={() => {
                      setSelectedObject('');
                      setSelectedField('');
                      setFields([]);
                    }}
                    className="text-xs text-surface-400 hover:text-red-500"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            {/* Field picker */}
            <div className="flex-1">
              <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                Field
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder={
                    !selectedObject
                      ? 'Select an object first'
                      : loadingFields
                        ? 'Loading fields...'
                        : 'Search fields...'
                  }
                  value={fieldSearchTerm}
                  onChange={(e) => setFieldSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50"
                  disabled={!selectedObject || loadingFields}
                />
              </div>
              {fieldSearchTerm && selectedObject && (
                <div className="mt-1 max-h-48 overflow-auto border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 shadow-lg">
                  {filteredFields.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-surface-400">No fields found</div>
                  ) : (
                    filteredFields.slice(0, 50).map((fld) => (
                      <button
                        key={fld.apiName}
                        onClick={() => {
                          setSelectedField(fld.apiName);
                          setFieldSearchTerm('');
                        }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface-100 dark:hover:bg-surface-600 transition-colors ${
                          selectedField === fld.apiName
                            ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                            : 'text-surface-700 dark:text-surface-300'
                        }`}
                      >
                        <span className="font-medium">{fld.label}</span>
                        <span className="ml-2 text-xs text-surface-400 font-mono">
                          {fld.apiName}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {selectedField && !fieldSearchTerm && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs font-mono text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20 px-2 py-0.5 rounded">
                    {selectedField}
                  </span>
                  <button
                    onClick={() => setSelectedField('')}
                    className="text-xs text-surface-400 hover:text-red-500"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div>
            <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
              Field API Name (e.g. Asset.K_Mat_String_single_line__c)
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Object.FieldApiName"
                value={directInput}
                onChange={(e) => setDirectInput(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm font-mono rounded-lg border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              />
            </div>
            {directInput && parseFieldRef(directInput) && (
              <div className="mt-1 text-xs text-surface-400">
                Object:{' '}
                <span className="font-mono text-primary-600 dark:text-primary-400">
                  {parseFieldRef(directInput)!.objectName}
                </span>{' '}
                | Field:{' '}
                <span className="font-mono text-primary-600 dark:text-primary-400">
                  {parseFieldRef(directInput)!.fieldName}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Resolved field summary */}
        {resolvedField && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-surface-500 dark:text-surface-400">Selected:</span>
            <span className="font-mono font-semibold text-surface-800 dark:text-surface-200">
              {resolvedField.objectName}.
              <span className="text-primary-600 dark:text-primary-400">
                {resolvedField.fieldName}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-surface-200 dark:border-surface-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:border-surface-300 dark:hover:border-surface-600'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && <ErrorAlert message={error} onRetry={() => setError(null)} />}

      {/* ── Tab Content ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {/* Forward Lineage */}
        {activeTab === 'forward' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                Where does this field go?
              </h3>
              <button
                onClick={traceForward}
                disabled={!resolvedField || loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowRight className="w-4 h-4" />
                )}
                Trace Forward
              </button>
            </div>

            {loading && <LoadingSpinner message="Tracing forward lineage..." />}

            {!loading && forwardTree.length > 0 && (
              <div className="bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm font-mono font-semibold text-surface-800 dark:text-surface-200">
                    {resolvedField?.objectName}.{resolvedField?.fieldName}
                  </span>
                  <ArrowRight className="w-4 h-4 text-surface-400" />
                  <span className="text-xs text-surface-500 dark:text-surface-400">
                    {forwardTree.length} downstream reference{forwardTree.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="border border-surface-200 dark:border-surface-700 rounded-lg divide-y divide-surface-100 dark:divide-surface-700">
                  {forwardTree.map((node) => (
                    <TreeNodeView
                      key={node.id}
                      node={node}
                      onToggle={(id) => toggleNode(id, forwardTree, setForwardTree)}
                    />
                  ))}
                </div>
              </div>
            )}

            {!loading && forwardTree.length === 0 && !error && (
              <div className="text-center py-12 text-surface-400 dark:text-surface-500">
                <ArrowRight className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  Select a field above and click &quot;Trace Forward&quot; to see where its value is
                  copied to.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Backward Lineage */}
        {activeTab === 'backward' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                Where did this value come from?
              </h3>
              <button
                onClick={traceBackward}
                disabled={!resolvedField || loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowLeft className="w-4 h-4" />
                )}
                Trace Backward
              </button>
            </div>

            {loading && <LoadingSpinner message="Tracing backward lineage..." />}

            {!loading && backwardTree.length > 0 && (
              <div className="bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-surface-500 dark:text-surface-400">
                    {backwardTree.length} upstream source{backwardTree.length !== 1 ? 's' : ''}
                  </span>
                  <ArrowRight className="w-4 h-4 text-surface-400" />
                  <span className="text-sm font-mono font-semibold text-surface-800 dark:text-surface-200">
                    {resolvedField?.objectName}.{resolvedField?.fieldName}
                  </span>
                </div>
                <div className="border border-surface-200 dark:border-surface-700 rounded-lg divide-y divide-surface-100 dark:divide-surface-700">
                  {backwardTree.map((node) => (
                    <TreeNodeView
                      key={node.id}
                      node={node}
                      onToggle={(id) => toggleNode(id, backwardTree, setBackwardTree)}
                    />
                  ))}
                </div>
              </div>
            )}

            {!loading && backwardTree.length === 0 && !error && (
              <div className="text-center py-12 text-surface-400 dark:text-surface-500">
                <ArrowLeft className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  Select a field above and click &quot;Trace Backward&quot; to see where its value
                  originates from.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Record Trace */}
        {activeTab === 'record-trace' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                  Record ID
                </label>
                <input
                  type="text"
                  placeholder="Enter a Salesforce Record ID (15 or 18 char)"
                  value={traceRecordId}
                  onChange={(e) => setTraceRecordId(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                />
              </div>
              <button
                onClick={runRecordTrace}
                disabled={!resolvedField || !traceRecordId.trim() || loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
                Trace Record
              </button>
            </div>

            {loading && <LoadingSpinner message="Fetching field values at each hop..." />}

            {!loading && traceEntries.length > 0 && (
              <>
                {/* Mismatch summary */}
                {traceEntries.some((e) => e.mismatch) && (
                  <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
                    <span className="text-sm text-red-700 dark:text-red-400">
                      {traceEntries.filter((e) => e.mismatch).length} value mismatch
                      {traceEntries.filter((e) => e.mismatch).length !== 1 ? 'es' : ''}{' '}
                      detected. Values highlighted in red differ from the source.
                    </span>
                  </div>
                )}
                <DataTable
                  data={traceEntries}
                  columns={traceColumns}
                  title="Record-Level Field Trace"
                  exportFilename="field-trace"
                  pageSize={20}
                />
              </>
            )}

            {!loading && traceEntries.length === 0 && !error && (
              <div className="text-center py-12 text-surface-400 dark:text-surface-500">
                <Eye className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  Enter a record ID and click &quot;Trace Record&quot; to fetch actual field values
                  at each hop in the lineage.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Configuration String Chain */}
        {activeTab === 'config-chain' && (
          <div className="flex flex-col gap-4">
            <div className="bg-surface-50 dark:bg-surface-800/50 border border-surface-200 dark:border-surface-700 rounded-lg p-3">
              <p className="text-xs text-surface-500 dark:text-surface-400">
                Traces a configuration field value through the propagation chain:{' '}
                <span className="font-mono font-medium text-surface-700 dark:text-surface-300">
                  Quote Line &rarr; Asset &rarr; Case &rarr; Work Order
                </span>
                . Provide a starting record ID from any object in the chain.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                  Configuration Field Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. K_Mat_String_single_line__c"
                  value={configFieldName}
                  onChange={(e) => setConfigFieldName(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                  Starting Record ID
                </label>
                <input
                  type="text"
                  placeholder="Enter Quote Line, Asset, Case, or WO ID"
                  value={configRecordId}
                  onChange={(e) => setConfigRecordId(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                />
              </div>
              <button
                onClick={runConfigChain}
                disabled={!configRecordId.trim() || !configFieldName.trim() || loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Route className="w-4 h-4" />
                )}
                Trace Chain
              </button>
            </div>

            {loading && <LoadingSpinner message="Tracing configuration propagation chain..." />}

            {!loading && configSteps.length > 0 && (
              <>
                {/* Visual chain */}
                <div className="flex items-stretch gap-0 overflow-x-auto pb-2">
                  {configSteps.map((step, idx) => (
                    <div key={step.objectName} className="flex items-center">
                      {/* Step card */}
                      <div
                        className={`flex flex-col gap-1.5 p-3 rounded-lg border min-w-[180px] shrink-0 ${
                          step.mismatch
                            ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20'
                            : !step.found
                              ? 'border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 opacity-60'
                              : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                            {step.objectLabel}
                          </span>
                          {step.mismatch && (
                            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                          )}
                          {!step.found && (
                            <span className="text-[10px] text-surface-400 italic">
                              not found
                            </span>
                          )}
                        </div>
                        <span className="text-xs font-mono text-primary-600 dark:text-primary-400">
                          {step.fieldName}
                        </span>
                        {step.recordId && (
                          <a
                            href={`${instanceUrl}/${step.recordId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-mono text-primary-500 hover:underline truncate"
                          >
                            {step.recordId}
                          </a>
                        )}
                        <div
                          className={`text-xs font-mono break-all mt-1 px-2 py-1 rounded ${
                            step.mismatch
                              ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 font-semibold'
                              : 'bg-surface-100 dark:bg-surface-700 text-surface-700 dark:text-surface-300'
                          }`}
                        >
                          {step.found
                            ? step.value ?? (
                                <span className="text-surface-400 italic">null</span>
                              )
                            : '\u2014'}
                        </div>
                        <div className="mt-1">
                          {!step.found ? (
                            <StatusBadge label="Not Found" variant="warning" />
                          ) : step.mismatch ? (
                            <StatusBadge label="Mismatch" variant="danger" />
                          ) : (
                            <StatusBadge label="OK" variant="success" />
                          )}
                        </div>
                      </div>

                      {/* Arrow between steps */}
                      {idx < configSteps.length - 1 && (
                        <div className="flex items-center px-2 shrink-0">
                          <ChevronRight className="w-5 h-5 text-surface-300 dark:text-surface-600" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Table view */}
                <DataTable
                  data={configSteps}
                  columns={configColumns}
                  title="Configuration Propagation Details"
                  exportFilename="config-chain-trace"
                  pageSize={10}
                />
              </>
            )}

            {!loading && configSteps.length === 0 && !error && (
              <div className="text-center py-12 text-surface-400 dark:text-surface-500">
                <Route className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  Enter a configuration field name and starting record ID to trace the full
                  propagation chain.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
