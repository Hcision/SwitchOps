import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ToggleLeft,
  RefreshCw,
  AlertTriangle,
  Shield,
  Clock,
  Download,
  RotateCcw,
  Zap,
  Play,
  Pause,
} from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import Modal from '@/components/Modal';
import { useAppStore } from '@/services/store';
import { queryAll, toolingQuery } from '@/services/salesforce';
import { saveAs } from 'file-saver';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutomationSwitchRecord {
  Id?: string;
  Disable_Flows__c: boolean;
  Disable_Triggers__c: boolean;
  [key: string]: unknown;
}

interface FlowRecord {
  Id: string;
  DefinitionId: string;
  FullName: string;
  ProcessType: string;
  Status: string;
  [key: string]: unknown;
}

interface FlowRow {
  id: string;
  definitionId: string;
  fullName: string;
  processType: string;
  triggerType: string;
  status: string;
  category: FlowCategory;
  enabled: boolean;
}

interface AuditEntry {
  timestamp: Date;
  flowName: string;
  oldState: string;
  newState: string;
  action: string;
}

interface ConfirmAction {
  type: 'single' | 'group' | 'preset';
  label: string;
  description: string;
  execute: () => void;
}

type FlowCategory =
  | 'Quote Automation'
  | 'Work Order Automation'
  | 'Case Automation'
  | 'Asset Automation'
  | 'SAP Integration'
  | 'Notifications'
  | 'Other';

type PresetName =
  | 'maintenance'
  | 'dataMigration'
  | 'fullLockdown'
  | 'normalOperations';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_PREFIXES: Record<FlowCategory, string[]> = {
  'Quote Automation': ['Quote', 'SBQQ', 'CPQ', 'quote', 'Approval_Quote'],
  'Work Order Automation': ['WorkOrder', 'WO_', 'Work_Order', 'FSL', 'ServiceAppointment', 'SA_'],
  'Case Automation': ['Case', 'case_', 'Case_'],
  'Asset Automation': ['Asset', 'asset_', 'Asset_'],
  'SAP Integration': ['SAP', 'sap_', 'SAP_', 'Integration_SAP', 'DTR'],
  'Notifications': ['Notification', 'Email', 'Alert', 'Notify', 'Send_', 'notification'],
  'Other': [],
};

const CATEGORY_ORDER: FlowCategory[] = [
  'Quote Automation',
  'Work Order Automation',
  'Case Automation',
  'Asset Automation',
  'SAP Integration',
  'Notifications',
  'Other',
];

const PRESET_CONFIGS: Record<PresetName, { label: string; description: string; icon: React.ReactNode }> = {
  maintenance: {
    label: 'Maintenance Mode',
    description: 'Disables SAP integrations and scheduled flows',
    icon: <Shield className="w-4 h-4" />,
  },
  dataMigration: {
    label: 'Data Migration Mode',
    description: 'Disables all record-triggered flows',
    icon: <Zap className="w-4 h-4" />,
  },
  fullLockdown: {
    label: 'Full Lockdown',
    description: 'Disables everything',
    icon: <Pause className="w-4 h-4" />,
  },
  normalOperations: {
    label: 'Normal Operations',
    description: 'Enables everything',
    icon: <Play className="w-4 h-4" />,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categorizeFlow(fullName: string): FlowCategory {
  for (const category of CATEGORY_ORDER) {
    if (category === 'Other') continue;
    const prefixes = CATEGORY_PREFIXES[category];
    if (prefixes.some((prefix) => fullName.startsWith(prefix))) {
      return category;
    }
  }
  return 'Other';
}

/** Common Salesforce objects used for trigger type inference. */
const TRIGGER_HINT_OBJECTS = [
  'Account', 'Contact', 'Opportunity', 'Lead', 'Case', 'Task',
  'Event', 'Order', 'Product2', 'Campaign', 'Contract', 'Quote',
  'User', 'WorkOrder', 'ServiceAppointment', 'Asset',
];

/**
 * Derive a trigger type string from ProcessType and FullName.
 * Since TriggerType is not available on the Flow Tooling API entity,
 * we infer it from naming conventions and ProcessType.
 */
function deriveTriggerType(processType: string, fullName: string): string {
  if (processType === 'RecordTriggeredFlow') return 'RecordAfterSave';
  if (processType === 'AutoLaunchedFlow') {
    const name = fullName.replace(/-\d+$/, '');
    for (const obj of TRIGGER_HINT_OBJECTS) {
      if (name.startsWith(obj) || name.includes(`_${obj}_`) || name.includes(`${obj}_`)) {
        return 'RecordAfterSave';
      }
    }
  }
  if (processType === 'Scheduled') return 'Scheduled';
  if (processType === 'PlatformEvent' || processType === 'CustomEvent') return 'PlatformEvent';
  return '';
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AutomationSwitch() {
  const { auth } = useAppStore();

  // ── Data state ───────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | undefined>();
  const [switchWarning, setSwitchWarning] = useState<string | null>(null);
  const [automationSwitch, setAutomationSwitch] = useState<AutomationSwitchRecord | null>(null);
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [entrySnapshot, setEntrySnapshot] = useState<FlowRow[]>([]);

  // ── UI state ─────────────────────────────────────────────────────────────
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<FlowCategory>>(new Set());
  const [activeTab, setActiveTab] = useState<'flows' | 'presets' | 'audit'>('flows');

  // ── Timer state ──────────────────────────────────────────────────────────
  const [disabledSince, setDisabledSince] = useState<Date | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showHourWarning, setShowHourWarning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────
  const allFlowsEnabled = useMemo(
    () => flows.length > 0 && flows.every((f) => f.enabled),
    [flows],
  );

  const anyFlowDisabled = useMemo(
    () => flows.some((f) => !f.enabled),
    [flows],
  );

  const flowsByCategory = useMemo(() => {
    const grouped = new Map<FlowCategory, FlowRow[]>();
    for (const cat of CATEGORY_ORDER) {
      grouped.set(cat, []);
    }
    for (const flow of flows) {
      const bucket = grouped.get(flow.category) ?? [];
      bucket.push(flow);
      grouped.set(flow.category, bucket);
    }
    // Remove empty categories
    for (const [cat, items] of grouped) {
      if (items.length === 0) grouped.delete(cat);
    }
    return grouped;
  }, [flows]);

  const globalDisabled = useMemo(
    () =>
      automationSwitch !== null &&
      (automationSwitch.Disable_Flows__c || automationSwitch.Disable_Triggers__c),
    [automationSwitch],
  );

  // ── Timer effect ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (disabledSince) {
      timerRef.current = setInterval(() => {
        const now = Date.now();
        const diff = now - disabledSince.getTime();
        setElapsedMs(diff);
        if (diff >= 3_600_000 && !showHourWarning) {
          setShowHourWarning(true);
        }
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setElapsedMs(0);
      setShowHourWarning(false);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [disabledSince, showHourWarning]);

  // Track when flows become disabled
  useEffect(() => {
    if (anyFlowDisabled && !disabledSince) {
      setDisabledSince(new Date());
    } else if (!anyFlowDisabled && disabledSince) {
      setDisabledSince(null);
    }
  }, [anyFlowDisabled, disabledSince]);

  // ── Data fetching ────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorDetails(undefined);

    try {
      // Fetch automation switch custom setting (may not exist in this org)
      setSwitchWarning(null);
      try {
        const switchResult = await queryAll<AutomationSwitchRecord>(
          'SELECT Disable_Flows__c, Disable_Triggers__c FROM Automation_Switch__c LIMIT 1',
        );
        if (switchResult.records.length > 0) {
          setAutomationSwitch(switchResult.records[0]);
        }
      } catch {
        setSwitchWarning('Automation_Switch__c custom setting not found in this org');
        setAutomationSwitch(null);
      }

      // Fetch all active flows via Tooling API
      const flowResult = await toolingQuery<FlowRecord>(
        "SELECT Id, DefinitionId, FullName, ProcessType, Status FROM Flow WHERE Status = 'Active'",
      );

      const flowRows: FlowRow[] = flowResult.records.map((rec) => ({
        id: rec.Id,
        definitionId: rec.DefinitionId,
        fullName: rec.FullName,
        processType: rec.ProcessType,
        triggerType: deriveTriggerType(rec.ProcessType, rec.FullName),
        status: rec.Status,
        category: categorizeFlow(rec.FullName),
        enabled: true,
      }));

      // Sort by category then name
      flowRows.sort((a, b) => {
        const catCmp = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
        if (catCmp !== 0) return catCmp;
        return a.fullName.localeCompare(b.fullName);
      });

      setFlows(flowRows);

      // Capture entry snapshot on first load
      if (entrySnapshot.length === 0) {
        setEntrySnapshot(flowRows.map((f) => ({ ...f })));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      if (err instanceof Error && err.stack) {
        setErrorDetails(err.stack);
      }
    } finally {
      setLoading(false);
    }
  }, [entrySnapshot.length]);

  // Load data on mount
  useEffect(() => {
    if (auth.isAuthenticated) {
      fetchData();
    }
  }, [auth.isAuthenticated, fetchData]);

  // ── Audit logging ────────────────────────────────────────────────────────
  const addAuditEntry = useCallback(
    (flowName: string, oldState: string, newState: string, action: string) => {
      setAuditLog((prev) => [
        ...prev,
        {
          timestamp: new Date(),
          flowName,
          oldState,
          newState,
          action,
        },
      ]);
    },
    [],
  );

  // ── Toggle handlers ──────────────────────────────────────────────────────
  const toggleFlow = useCallback(
    (flowId: string) => {
      setFlows((prev) =>
        prev.map((f) => {
          if (f.id === flowId) {
            const oldState = f.enabled ? 'Enabled' : 'Disabled';
            const newState = f.enabled ? 'Disabled' : 'Enabled';
            addAuditEntry(f.fullName, oldState, newState, 'Individual toggle');
            return { ...f, enabled: !f.enabled };
          }
          return f;
        }),
      );
    },
    [addAuditEntry],
  );

  const toggleCategory = useCallback(
    (category: FlowCategory, enable: boolean) => {
      setFlows((prev) =>
        prev.map((f) => {
          if (f.category === category && f.enabled !== enable) {
            const oldState = f.enabled ? 'Enabled' : 'Disabled';
            const newState = enable ? 'Enabled' : 'Disabled';
            addAuditEntry(f.fullName, oldState, newState, `Group toggle: ${category}`);
            return { ...f, enabled: enable };
          }
          return f;
        }),
      );
    },
    [addAuditEntry],
  );

  const confirmToggleFlow = useCallback(
    (flow: FlowRow) => {
      if (flow.enabled) {
        // Deactivation requires confirmation
        setConfirmAction({
          type: 'single',
          label: `Disable ${flow.fullName}`,
          description: `Are you sure you want to disable the flow "${flow.fullName}"? This will stop it from executing.`,
          execute: () => {
            toggleFlow(flow.id);
            setConfirmAction(null);
          },
        });
      } else {
        // Activation is immediate
        toggleFlow(flow.id);
      }
    },
    [toggleFlow],
  );

  const confirmToggleCategory = useCallback(
    (category: FlowCategory, enable: boolean) => {
      if (!enable) {
        const count = flows.filter((f) => f.category === category && f.enabled).length;
        setConfirmAction({
          type: 'group',
          label: `Disable all ${category}`,
          description: `Are you sure you want to disable all ${count} flow(s) in "${category}"? This may impact business processes.`,
          execute: () => {
            toggleCategory(category, false);
            setConfirmAction(null);
          },
        });
      } else {
        toggleCategory(category, true);
      }
    },
    [flows, toggleCategory],
  );

  // ── Presets ──────────────────────────────────────────────────────────────
  const applyPreset = useCallback(
    (preset: PresetName) => {
      const descriptions: Record<PresetName, string> = {
        maintenance: 'Maintenance Mode: disable SAP integrations and scheduled flows',
        dataMigration: 'Data Migration Mode: disable all record-triggered flows',
        fullLockdown: 'Full Lockdown: disable all flows',
        normalOperations: 'Normal Operations: enable all flows',
      };

      setConfirmAction({
        type: 'preset',
        label: PRESET_CONFIGS[preset].label,
        description: `Apply preset "${descriptions[preset]}"?`,
        execute: () => {
          setFlows((prev) =>
            prev.map((f) => {
              let shouldEnable = f.enabled;

              switch (preset) {
                case 'maintenance':
                  if (f.category === 'SAP Integration' || f.triggerType === 'Scheduled') {
                    shouldEnable = false;
                  }
                  break;
                case 'dataMigration':
                  if (f.triggerType === 'RecordBeforeSave' || f.triggerType === 'RecordAfterSave' || f.triggerType === 'RecordBeforeDelete') {
                    shouldEnable = false;
                  }
                  break;
                case 'fullLockdown':
                  shouldEnable = false;
                  break;
                case 'normalOperations':
                  shouldEnable = true;
                  break;
              }

              if (f.enabled !== shouldEnable) {
                addAuditEntry(
                  f.fullName,
                  f.enabled ? 'Enabled' : 'Disabled',
                  shouldEnable ? 'Enabled' : 'Disabled',
                  `Preset: ${PRESET_CONFIGS[preset].label}`,
                );
              }
              return { ...f, enabled: shouldEnable };
            }),
          );
          setConfirmAction(null);
        },
      });
    },
    [addAuditEntry],
  );

  // ── Restore entry state ──────────────────────────────────────────────────
  const restoreEntryState = useCallback(() => {
    setConfirmAction({
      type: 'preset',
      label: 'Restore to Entry State',
      description:
        'This will revert all flow states back to their values when you first loaded this tool. Continue?',
      execute: () => {
        setFlows((prev) =>
          prev.map((f) => {
            const original = entrySnapshot.find((s) => s.id === f.id);
            const shouldEnable = original ? original.enabled : f.enabled;
            if (f.enabled !== shouldEnable) {
              addAuditEntry(
                f.fullName,
                f.enabled ? 'Enabled' : 'Disabled',
                shouldEnable ? 'Enabled' : 'Disabled',
                'Restore to entry state',
              );
            }
            return { ...f, enabled: shouldEnable };
          }),
        );
        setConfirmAction(null);
      },
    });
  }, [entrySnapshot, addAuditEntry]);

  // ── Export audit log ─────────────────────────────────────────────────────
  const exportAuditLog = useCallback(() => {
    const headers = ['Timestamp', 'Flow Name', 'Old State', 'New State', 'Action'];
    const rows = auditLog.map((entry) => [
      entry.timestamp.toISOString(),
      `"${entry.flowName.replace(/"/g, '""')}"`,
      entry.oldState,
      entry.newState,
      `"${entry.action.replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `automation-audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
  }, [auditLog]);

  // ── Group collapse toggle ────────────────────────────────────────────────
  const toggleGroupCollapse = useCallback((category: FlowCategory) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  // ── Audit table columns ──────────────────────────────────────────────────
  const auditColumns = useMemo<ColumnDef<AuditEntry, unknown>[]>(
    () => [
      {
        id: 'timestamp',
        header: 'Time',
        accessorFn: (row) => formatTimestamp(row.timestamp),
      },
      {
        id: 'flowName',
        header: 'Flow Name',
        accessorKey: 'flowName',
      },
      {
        id: 'oldState',
        header: 'Old State',
        accessorKey: 'oldState',
        cell: ({ getValue }) => {
          const val = getValue() as string;
          return (
            <StatusBadge
              label={val}
              variant={val === 'Enabled' ? 'success' : 'danger'}
            />
          );
        },
      },
      {
        id: 'newState',
        header: 'New State',
        accessorKey: 'newState',
        cell: ({ getValue }) => {
          const val = getValue() as string;
          return (
            <StatusBadge
              label={val}
              variant={val === 'Enabled' ? 'success' : 'danger'}
            />
          );
        },
      },
      {
        id: 'action',
        header: 'Action',
        accessorKey: 'action',
      },
    ],
    [],
  );

  // ── Render helpers ───────────────────────────────────────────────────────
  const renderToggle = (enabled: boolean, onToggle: () => void, size: 'sm' | 'lg' = 'sm') => {
    const sizeClasses =
      size === 'lg'
        ? 'w-14 h-7 after:w-6 after:h-6 after:top-0.5 after:start-[2px] peer-checked:after:translate-x-7'
        : 'w-10 h-5 after:w-4 after:h-4 after:top-0.5 after:start-[2px] peer-checked:after:translate-x-5';

    return (
      <label className="relative inline-flex items-center cursor-pointer">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={enabled}
          onChange={onToggle}
        />
        <div
          className={`${sizeClasses} rounded-full peer
            bg-surface-300 dark:bg-surface-600
            peer-checked:bg-green-500 dark:peer-checked:bg-green-600
            after:content-[''] after:absolute after:bg-white after:rounded-full
            after:transition-all after:duration-200
            peer-focus:ring-2 peer-focus:ring-green-500/40`}
        />
      </label>
    );
  };

  // ── Loading & error states ───────────────────────────────────────────────
  if (!auth.isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-surface-500 dark:text-surface-400">
          Please log in to use the Automation Switch Control Center.
        </p>
      </div>
    );
  }

  if (loading && flows.length === 0) {
    return <LoadingSpinner message="Loading automation switch data..." />;
  }

  // ── Main render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-auto">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary-100 dark:bg-primary-900/30">
            <ToggleLeft className="w-6 h-6 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-800 dark:text-surface-100">
              Automation Switch Control Center
            </h1>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Manage flow activation states and automation controls
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={restoreEntryState}
            disabled={entrySnapshot.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                       border border-surface-200 dark:border-surface-600
                       text-surface-700 dark:text-surface-300
                       hover:bg-surface-50 dark:hover:bg-surface-800
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Restore Entry State
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                       bg-primary-600 text-white hover:bg-primary-700
                       disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <ErrorAlert
          title="Failed to load automation data"
          message={error}
          details={errorDetails}
          onRetry={fetchData}
        />
      )}

      {/* ── Custom Setting Warning ──────────────────────────────────────── */}
      {switchWarning && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {switchWarning}
        </div>
      )}

      {/* ── Current State Banner ──────────────────────────────────────────── */}
      <div
        className={`rounded-xl p-6 border-2 transition-colors ${
          globalDisabled
            ? 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20'
            : allFlowsEnabled
              ? 'border-green-400 dark:border-green-600 bg-green-50 dark:bg-green-900/20'
              : 'border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div
              className={`p-3 rounded-full ${
                globalDisabled
                  ? 'bg-red-100 dark:bg-red-900/40'
                  : allFlowsEnabled
                    ? 'bg-green-100 dark:bg-green-900/40'
                    : 'bg-amber-100 dark:bg-amber-900/40'
              }`}
            >
              {globalDisabled ? (
                <Pause className="w-8 h-8 text-red-600 dark:text-red-400" />
              ) : allFlowsEnabled ? (
                <Play className="w-8 h-8 text-green-600 dark:text-green-400" />
              ) : (
                <AlertTriangle className="w-8 h-8 text-amber-600 dark:text-amber-400" />
              )}
            </div>
            <div>
              <h2
                className={`text-2xl font-bold ${
                  globalDisabled
                    ? 'text-red-700 dark:text-red-300'
                    : allFlowsEnabled
                      ? 'text-green-700 dark:text-green-300'
                      : 'text-amber-700 dark:text-amber-300'
                }`}
              >
                {globalDisabled
                  ? 'ALL FLOWS: DISABLED'
                  : allFlowsEnabled
                    ? 'ALL FLOWS: ENABLED'
                    : `FLOWS: ${flows.filter((f) => !f.enabled).length} DISABLED`}
              </h2>
              <p
                className={`text-sm mt-1 ${
                  globalDisabled
                    ? 'text-red-600 dark:text-red-400'
                    : allFlowsEnabled
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                {globalDisabled
                  ? 'Automation Switch custom setting is active - flows/triggers are globally disabled'
                  : `${flows.filter((f) => f.enabled).length} of ${flows.length} flows active`}
              </p>
            </div>
          </div>

          {/* Disabled timer */}
          {disabledSince && (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2 text-sm text-surface-600 dark:text-surface-400">
                <Clock className="w-4 h-4" />
                <span>Disabled for: {formatDuration(elapsedMs)}</span>
              </div>
              {showHourWarning && (
                <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 animate-pulse">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Flows have been disabled for over 1 hour</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Custom setting details */}
        {automationSwitch && (
          <div className="flex gap-6 mt-4 pt-4 border-t border-current/10">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-surface-600 dark:text-surface-400">Disable_Flows__c:</span>
              <StatusBadge
                label={automationSwitch.Disable_Flows__c ? 'TRUE' : 'FALSE'}
                variant={automationSwitch.Disable_Flows__c ? 'danger' : 'success'}
              />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-surface-600 dark:text-surface-400">Disable_Triggers__c:</span>
              <StatusBadge
                label={automationSwitch.Disable_Triggers__c ? 'TRUE' : 'FALSE'}
                variant={automationSwitch.Disable_Triggers__c ? 'danger' : 'success'}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Hour warning modal ────────────────────────────────────────────── */}
      {showHourWarning && (
        <div className="rounded-xl p-4 border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
              Extended Disable Warning
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">
              One or more flows have been disabled for over 1 hour ({formatDuration(elapsedMs)}).
              Please verify this is intentional and consider re-enabling flows if maintenance is complete.
            </p>
          </div>
          <button
            onClick={() => setShowHourWarning(false)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 hover:bg-amber-300 dark:hover:bg-amber-700 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div className="flex gap-1 p-1 rounded-xl bg-surface-100 dark:bg-surface-800 w-fit">
        {([
          { key: 'flows' as const, label: 'Flow Control', icon: <Zap className="w-4 h-4" /> },
          { key: 'presets' as const, label: 'Presets', icon: <Shield className="w-4 h-4" /> },
          { key: 'audit' as const, label: `Audit Log (${auditLog.length})`, icon: <Clock className="w-4 h-4" /> },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-100 shadow-sm'
                : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Flow Control Tab ──────────────────────────────────────────────── */}
      {activeTab === 'flows' && (
        <div className="flex flex-col gap-4">
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">Total Flows</p>
              <p className="text-2xl font-bold text-surface-800 dark:text-surface-100 mt-1">{flows.length}</p>
            </div>
            <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4">
              <p className="text-xs text-green-600 dark:text-green-400 uppercase tracking-wider">Enabled</p>
              <p className="text-2xl font-bold text-green-700 dark:text-green-300 mt-1">
                {flows.filter((f) => f.enabled).length}
              </p>
            </div>
            <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
              <p className="text-xs text-red-600 dark:text-red-400 uppercase tracking-wider">Disabled</p>
              <p className="text-2xl font-bold text-red-700 dark:text-red-300 mt-1">
                {flows.filter((f) => !f.enabled).length}
              </p>
            </div>
            <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">Categories</p>
              <p className="text-2xl font-bold text-surface-800 dark:text-surface-100 mt-1">
                {flowsByCategory.size}
              </p>
            </div>
          </div>

          {/* Grouped flow table */}
          {Array.from(flowsByCategory.entries()).map(([category, categoryFlows]) => {
            const allEnabled = categoryFlows.every((f) => f.enabled);
            const someEnabled = categoryFlows.some((f) => f.enabled);
            const enabledCount = categoryFlows.filter((f) => f.enabled).length;
            const isCollapsed = collapsedGroups.has(category);

            return (
              <div
                key={category}
                className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 overflow-hidden"
              >
                {/* Group header */}
                <div
                  className="flex items-center justify-between px-4 py-3 bg-surface-50 dark:bg-surface-800/50 cursor-pointer select-none"
                  onClick={() => toggleGroupCollapse(category)}
                >
                  <div className="flex items-center gap-3">
                    <button className="text-surface-400 hover:text-surface-600 dark:hover:text-surface-300">
                      <svg
                        className={`w-4 h-4 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                    <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                      {category}
                    </h3>
                    <span className="text-xs text-surface-400">
                      {enabledCount}/{categoryFlows.length} enabled
                    </span>
                    <StatusBadge
                      label={allEnabled ? 'All Active' : someEnabled ? 'Partial' : 'All Disabled'}
                      variant={allEnabled ? 'success' : someEnabled ? 'warning' : 'danger'}
                    />
                  </div>
                  <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                    <span className="text-xs text-surface-500 dark:text-surface-400">
                      {allEnabled ? 'Disable All' : 'Enable All'}
                    </span>
                    {renderToggle(allEnabled, () => {
                      confirmToggleCategory(category, !allEnabled);
                    })}
                  </div>
                </div>

                {/* Flow rows */}
                {!isCollapsed && (
                  <div className="divide-y divide-surface-100 dark:divide-surface-800">
                    {categoryFlows.map((flow) => (
                      <div
                        key={flow.id}
                        className="flex items-center justify-between px-6 py-2.5 hover:bg-surface-50 dark:hover:bg-surface-800/30 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              flow.enabled
                                ? 'bg-green-500'
                                : 'bg-red-500'
                            }`}
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-surface-800 dark:text-surface-200 truncate">
                              {flow.fullName}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs text-surface-400">
                                {flow.processType}
                              </span>
                              {flow.triggerType && (
                                <>
                                  <span className="text-xs text-surface-300 dark:text-surface-600">/</span>
                                  <span className="text-xs text-surface-400">
                                    {flow.triggerType}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <StatusBadge
                            label={flow.enabled ? 'Enabled' : 'Disabled'}
                            variant={flow.enabled ? 'success' : 'danger'}
                          />
                          {renderToggle(flow.enabled, () => confirmToggleFlow(flow))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {flows.length === 0 && !loading && !error && (
            <div className="flex flex-col items-center justify-center py-12 text-surface-400 dark:text-surface-500">
              <Zap className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">No active flows found in this org.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Presets Tab ───────────────────────────────────────────────────── */}
      {activeTab === 'presets' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {(Object.entries(PRESET_CONFIGS) as [PresetName, typeof PRESET_CONFIGS[PresetName]][]).map(
            ([key, preset]) => {
              const isDangerous = key === 'fullLockdown';
              const isSafe = key === 'normalOperations';

              return (
                <button
                  key={key}
                  onClick={() => applyPreset(key)}
                  className={`flex items-start gap-4 p-5 rounded-xl border-2 text-left transition-all
                    hover:shadow-md active:scale-[0.99] ${
                      isDangerous
                        ? 'border-red-200 dark:border-red-800 hover:border-red-400 dark:hover:border-red-600 bg-white dark:bg-surface-900'
                        : isSafe
                          ? 'border-green-200 dark:border-green-800 hover:border-green-400 dark:hover:border-green-600 bg-white dark:bg-surface-900'
                          : 'border-surface-200 dark:border-surface-700 hover:border-primary-400 dark:hover:border-primary-600 bg-white dark:bg-surface-900'
                    }`}
                >
                  <div
                    className={`p-2.5 rounded-lg shrink-0 ${
                      isDangerous
                        ? 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400'
                        : isSafe
                          ? 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400'
                          : 'bg-primary-100 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400'
                    }`}
                  >
                    {preset.icon}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                      {preset.label}
                    </h3>
                    <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                      {preset.description}
                    </p>
                  </div>
                </button>
              );
            },
          )}
        </div>
      )}

      {/* ── Audit Log Tab ─────────────────────────────────────────────────── */}
      {activeTab === 'audit' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-surface-500 dark:text-surface-400">
              {auditLog.length === 0
                ? 'No changes recorded this session.'
                : `${auditLog.length} change(s) recorded this session.`}
            </p>
            {auditLog.length > 0 && (
              <button
                onClick={exportAuditLog}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg
                           border border-surface-200 dark:border-surface-600
                           text-surface-700 dark:text-surface-300
                           hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </button>
            )}
          </div>

          {auditLog.length > 0 ? (
            <DataTable
              data={auditLog}
              columns={auditColumns}
              title="Session Audit Log"
              exportable={false}
              searchable
              pageSize={20}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-surface-400 dark:text-surface-500 border border-dashed border-surface-200 dark:border-surface-700 rounded-xl">
              <Clock className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">Toggle a flow to see audit entries here.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Confirmation Modal ────────────────────────────────────────────── */}
      <Modal
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title="Confirm Action"
      >
        {confirmAction && (
          <div className="flex flex-col gap-5">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/40 shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                  {confirmAction.label}
                </h3>
                <p className="text-sm text-surface-600 dark:text-surface-400 mt-1">
                  {confirmAction.description}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg
                           border border-surface-200 dark:border-surface-600
                           text-surface-700 dark:text-surface-300
                           hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmAction.execute}
                className="px-4 py-2 text-sm font-medium rounded-lg
                           bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
