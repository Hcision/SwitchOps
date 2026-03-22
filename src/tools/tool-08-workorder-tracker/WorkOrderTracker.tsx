import { useState, useCallback } from 'react';
import {
  Truck,
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Clock,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { useAppStore } from '@/services/store';
import { query, queryAll } from '@/services/salesforce';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkOrderRecord {
  Id: string;
  WorkOrderNumber: string;
  Status: string;
  Subject: string | null;
  CaseId: string | null;
  AssetId: string | null;
  StartDate: string | null;
  EndDate: string | null;
  SAP_DTR_Order_Reference__c: string | null;
  DTR_Order_SAP_Synchronisation_Status__c: string | null;
  [key: string]: unknown;
}

interface WorkOrderLineItemRecord {
  Id: string;
  LineItemNumber: string;
  WorkOrderId: string;
  Status: string;
  Subject: string | null;
  StartDate: string | null;
  EndDate: string | null;
  [key: string]: unknown;
}

interface WorkStepRecord {
  Id: string;
  Name: string;
  WorkOrderId: string;
  StepNumber: number | null;
  Status: string | null;
  ActionType: string | null;
  Description: string | null;
  StartDate: string | null;
  EndDate: string | null;
  [key: string]: unknown;
}

interface ServiceAppointmentRecord {
  Id: string;
  AppointmentNumber: string;
  ParentRecordId: string;
  Status: string;
  SchedStartTime: string | null;
  SchedEndTime: string | null;
  ActualStartTime: string | null;
  ActualEndTime: string | null;
  [key: string]: unknown;
}

interface CaseRecord {
  Id: string;
  CaseNumber: string;
  Status: string;
  Subject: string | null;
  CreatedDate: string;
  ClosedDate: string | null;
  [key: string]: unknown;
}

interface AssetRecord {
  Id: string;
  Name: string;
  SerialNumber: string | null;
  Status: string | null;
  InstallDate: string | null;
  [key: string]: unknown;
}

interface Bottleneck {
  type: 'overdue' | 'unscheduled' | 'sync-failure';
  severity: 'warning' | 'danger';
  entity: string;
  message: string;
  recordId: string;
}

interface DatePropagationEntry {
  entity: string;
  field: string;
  value: string | null;
  recordId: string;
}

type SearchMode = 'single' | 'batch';

type BatchFilterField = 'Status' | 'Territory';

interface SwimlaneSection {
  key: string;
  label: string;
  expanded: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COLOR_MAP: Record<string, 'info' | 'warning' | 'success' | 'neutral' | 'danger'> = {
  new: 'info',
  open: 'info',
  'in progress': 'warning',
  'on hold': 'warning',
  scheduled: 'warning',
  dispatched: 'warning',
  completed: 'success',
  closed: 'success',
  canceled: 'neutral',
  cancelled: 'neutral',
  'cannot complete': 'danger',
  failed: 'danger',
  error: 'danger',
};

const SWIMLANE_ROWS: SwimlaneSection[] = [
  { key: 'case', label: 'Case', expanded: true },
  { key: 'asset', label: 'Asset', expanded: true },
  { key: 'workorder', label: 'Work Order', expanded: true },
  { key: 'lineitems', label: 'Line Items', expanded: true },
  { key: 'worksteps', label: 'Work Steps', expanded: true },
  { key: 'appointments', label: 'Service Appointments', expanded: true },
  { key: 'sapsync', label: 'SAP Sync', expanded: true },
];

const BATCH_STATUSES = ['New', 'Open', 'In Progress', 'On Hold', 'Completed', 'Closed', 'Canceled'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStatusVariant(status: string | null | undefined): 'info' | 'warning' | 'success' | 'neutral' | 'danger' {
  if (!status) return 'neutral';
  return STATUS_COLOR_MAP[status.toLowerCase()] ?? 'neutral';
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sfLink(instanceUrl: string, recordId: string): string {
  return `${instanceUrl}/${recordId}`;
}

function isOverdue(endDate: string | null | undefined, status: string | null | undefined): boolean {
  if (!endDate || !status) return false;
  const lower = status.toLowerCase();
  if (lower === 'completed' || lower === 'closed' || lower === 'canceled' || lower === 'cancelled') return false;
  return new Date(endDate) < new Date();
}

// ---------------------------------------------------------------------------
// Work Order Table Columns (for batch results)
// ---------------------------------------------------------------------------

const batchColumns: ColumnDef<WorkOrderRecord, unknown>[] = [
  {
    accessorKey: 'WorkOrderNumber',
    header: 'WO Number',
    cell: ({ getValue }) => (
      <span className="text-sm font-mono font-medium text-primary-600 dark:text-primary-400">
        {getValue<string>()}
      </span>
    ),
  },
  {
    accessorKey: 'Status',
    header: 'Status',
    cell: ({ getValue }) => {
      const val = getValue<string>();
      return <StatusBadge label={val ?? 'Unknown'} variant={getStatusVariant(val)} />;
    },
  },
  {
    accessorKey: 'Subject',
    header: 'Subject',
    cell: ({ getValue }) => (
      <span className="text-xs max-w-[250px] block truncate">{getValue<string>() || '\u2014'}</span>
    ),
  },
  {
    accessorKey: 'StartDate',
    header: 'Start',
    cell: ({ getValue }) => <span className="text-xs whitespace-nowrap">{formatDate(getValue<string>())}</span>,
  },
  {
    accessorKey: 'EndDate',
    header: 'End',
    cell: ({ getValue }) => <span className="text-xs whitespace-nowrap">{formatDate(getValue<string>())}</span>,
  },
  {
    accessorKey: 'DTR_Order_SAP_Synchronisation_Status__c',
    header: 'SAP Sync',
    cell: ({ getValue }) => {
      const val = getValue<string>();
      if (!val) return <span className="text-xs text-surface-400">\u2014</span>;
      const variant = val.toLowerCase().includes('success')
        ? 'success'
        : val.toLowerCase().includes('error') || val.toLowerCase().includes('fail')
          ? 'danger'
          : 'warning';
      return <StatusBadge label={val} variant={variant} />;
    },
  },
];

// ---------------------------------------------------------------------------
// Swimlane Card Component
// ---------------------------------------------------------------------------

interface SwimlaneCardProps {
  title: string;
  subtitle?: string;
  status: string | null;
  dates?: { label: string; value: string | null }[];
  recordId: string;
  instanceUrl: string;
  isBottleneck?: boolean;
  bottleneckMessage?: string;
}

function SwimlaneCard({
  title,
  subtitle,
  status,
  dates,
  recordId,
  instanceUrl,
  isBottleneck,
  bottleneckMessage,
}: SwimlaneCardProps) {
  return (
    <div
      className={`relative flex flex-col gap-1.5 p-3 rounded-lg border min-w-[200px] max-w-[280px] shrink-0 transition-shadow
        ${
          isBottleneck
            ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 shadow-sm shadow-red-200 dark:shadow-red-900/30'
            : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 hover:shadow-md'
        }`}
    >
      {/* Bottleneck indicator */}
      {isBottleneck && (
        <div className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 font-medium">
          <AlertTriangle className="w-3 h-3" />
          {bottleneckMessage}
        </div>
      )}

      {/* Title + SF link */}
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-surface-800 dark:text-surface-200 leading-tight">
          {title}
        </span>
        <a
          href={sfLink(instanceUrl, recordId)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-500 hover:text-primary-700 dark:hover:text-primary-300 shrink-0"
          title="Open in Salesforce"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      {/* Subtitle */}
      {subtitle && (
        <span className="text-xs text-surface-500 dark:text-surface-400 truncate">{subtitle}</span>
      )}

      {/* Status badge */}
      {status && <StatusBadge label={status} variant={getStatusVariant(status)} />}

      {/* Dates */}
      {dates && dates.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-1">
          {dates.map((d) => (
            <span key={d.label} className="text-[11px] text-surface-400 dark:text-surface-500">
              {d.label}: {formatDate(d.value)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function WorkOrderTracker() {
  // ── Store ─────────────────────────────────────────────────────────────────
  const instanceUrl = useAppStore((s) => s.auth.instanceUrl);

  // ── Search state ──────────────────────────────────────────────────────────
  const [searchMode, setSearchMode] = useState<SearchMode>('single');
  const [searchInput, setSearchInput] = useState('');
  const [batchFilterField, setBatchFilterField] = useState<BatchFilterField>('Status');
  const [batchFilterValue, setBatchFilterValue] = useState('');

  // ── Loading / error ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Work order data ───────────────────────────────────────────────────────
  const [workOrders, setWorkOrders] = useState<WorkOrderRecord[]>([]);
  const [selectedWO, setSelectedWO] = useState<WorkOrderRecord | null>(null);

  // ── Related data ──────────────────────────────────────────────────────────
  const [lineItems, setLineItems] = useState<WorkOrderLineItemRecord[]>([]);
  const [workSteps, setWorkSteps] = useState<WorkStepRecord[]>([]);
  const [appointments, setAppointments] = useState<ServiceAppointmentRecord[]>([]);
  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [assetRecord, setAssetRecord] = useState<AssetRecord | null>(null);

  // ── SAP fields availability ─────────────────────────────────────────────
  const [sapFieldsAvailable, setSapFieldsAvailable] = useState(true);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [swimlaneSections, setSwimlaneSections] = useState<SwimlaneSection[]>(SWIMLANE_ROWS);
  const [showDatePropagation, setShowDatePropagation] = useState(false);

  // ── Bottlenecks ───────────────────────────────────────────────────────────
  const [bottlenecks, setBottlenecks] = useState<Bottleneck[]>([]);

  // ── Swimlane toggle ───────────────────────────────────────────────────────
  const toggleSwimlaneSection = (key: string) => {
    setSwimlaneSections((prev) =>
      prev.map((s) => (s.key === key ? { ...s, expanded: !s.expanded } : s)),
    );
  };

  // ── Search handler ────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    const trimmed = searchInput.trim();
    if (!trimmed) return;

    try {
      setLoading(true);
      setError(null);
      setSelectedWO(null);
      setLineItems([]);
      setWorkSteps([]);
      setAppointments([]);
      setCaseRecord(null);
      setAssetRecord(null);
      setBottlenecks([]);

      // First query with only standard fields
      const standardSoql =
        `SELECT Id, WorkOrderNumber, Status, Subject, CaseId, AssetId, StartDate, EndDate ` +
        `FROM WorkOrder ` +
        `WHERE WorkOrderNumber = '${trimmed}' ` +
        `OR CaseId IN (SELECT Id FROM Case WHERE CaseNumber = '${trimmed}')`;

      const result = await query<WorkOrderRecord>(standardSoql);
      const records = result.records;

      // Attempt to enrich with SAP-specific fields
      let hasSapFields = true;
      if (records.length > 0) {
        const woIds = records.map((r) => `'${r.Id}'`).join(',');
        try {
          const sapResult = await query<{ Id: string; SAP_DTR_Order_Reference__c: string | null; DTR_Order_SAP_Synchronisation_Status__c: string | null }>(
            `SELECT Id, SAP_DTR_Order_Reference__c, DTR_Order_SAP_Synchronisation_Status__c ` +
            `FROM WorkOrder WHERE Id IN (${woIds})`,
          );
          const sapMap = new Map(sapResult.records.map((r) => [r.Id, r]));
          records.forEach((wo) => {
            const sapData = sapMap.get(wo.Id);
            if (sapData) {
              wo.SAP_DTR_Order_Reference__c = sapData.SAP_DTR_Order_Reference__c;
              wo.DTR_Order_SAP_Synchronisation_Status__c = sapData.DTR_Order_SAP_Synchronisation_Status__c;
            }
          });
        } catch {
          hasSapFields = false;
          records.forEach((wo) => {
            wo.SAP_DTR_Order_Reference__c = null;
            wo.DTR_Order_SAP_Synchronisation_Status__c = null;
          });
        }
      }

      setSapFieldsAvailable(hasSapFields);
      setWorkOrders(records);

      if (records.length === 1) {
        await loadRelatedData(records[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search work orders');
    } finally {
      setLoading(false);
    }
  }, [searchInput]);

  // ── Batch lookup handler ──────────────────────────────────────────────────
  const handleBatchLookup = useCallback(async () => {
    const trimmed = batchFilterValue.trim();
    if (!trimmed) return;

    try {
      setLoading(true);
      setError(null);
      setSelectedWO(null);
      setLineItems([]);
      setWorkSteps([]);
      setAppointments([]);
      setCaseRecord(null);
      setAssetRecord(null);
      setBottlenecks([]);

      // Query with standard fields only first
      let standardSoql: string;
      if (batchFilterField === 'Status') {
        standardSoql =
          `SELECT Id, WorkOrderNumber, Status, Subject, CaseId, AssetId, StartDate, EndDate ` +
          `FROM WorkOrder WHERE Status = '${trimmed}' ORDER BY CreatedDate DESC LIMIT 200`;
      } else {
        standardSoql =
          `SELECT Id, WorkOrderNumber, Status, Subject, CaseId, AssetId, StartDate, EndDate ` +
          `FROM WorkOrder WHERE ServiceTerritoryId IN ` +
          `(SELECT Id FROM ServiceTerritory WHERE Name LIKE '%${trimmed}%') ` +
          `ORDER BY CreatedDate DESC LIMIT 200`;
      }

      const result = await queryAll<WorkOrderRecord>(standardSoql);
      const records = result.records;

      // Attempt to enrich with SAP-specific fields
      let hasSapFields = true;
      if (records.length > 0) {
        const woIds = records.map((r) => `'${r.Id}'`).join(',');
        try {
          const sapResult = await queryAll<{ Id: string; SAP_DTR_Order_Reference__c: string | null; DTR_Order_SAP_Synchronisation_Status__c: string | null }>(
            `SELECT Id, SAP_DTR_Order_Reference__c, DTR_Order_SAP_Synchronisation_Status__c ` +
            `FROM WorkOrder WHERE Id IN (${woIds})`,
          );
          const sapMap = new Map(sapResult.records.map((r) => [r.Id, r]));
          records.forEach((wo) => {
            const sapData = sapMap.get(wo.Id);
            if (sapData) {
              wo.SAP_DTR_Order_Reference__c = sapData.SAP_DTR_Order_Reference__c;
              wo.DTR_Order_SAP_Synchronisation_Status__c = sapData.DTR_Order_SAP_Synchronisation_Status__c;
            }
          });
        } catch {
          hasSapFields = false;
          records.forEach((wo) => {
            wo.SAP_DTR_Order_Reference__c = null;
            wo.DTR_Order_SAP_Synchronisation_Status__c = null;
          });
        }
      }

      setSapFieldsAvailable(hasSapFields);
      setWorkOrders(records);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load work orders');
    } finally {
      setLoading(false);
    }
  }, [batchFilterField, batchFilterValue]);

  // ── Load related data for a selected WO ───────────────────────────────────
  const loadRelatedData = useCallback(
    async (wo: WorkOrderRecord) => {
      try {
        setSelectedWO(wo);
        setLoading(true);
        setError(null);

        // Fetch line items and work steps in parallel
        const [liResult, wsResult] = await Promise.all([
          queryAll<WorkOrderLineItemRecord>(
            `SELECT Id, LineItemNumber, WorkOrderId, Status, Subject, StartDate, EndDate ` +
              `FROM WorkOrderLineItem WHERE WorkOrderId = '${wo.Id}'`,
          ),
          queryAll<WorkStepRecord>(
            `SELECT Id, Name, WorkOrderId, StepNumber, Status, ActionType, Description, StartDate, EndDate ` +
              `FROM WorkStep WHERE WorkOrderId = '${wo.Id}' ORDER BY StepNumber`,
          ),
        ]);

        setLineItems(liResult.records);
        setWorkSteps(wsResult.records);

        // Fetch service appointments if line items exist
        let saRecords: ServiceAppointmentRecord[] = [];
        const allParentIds = [wo.Id, ...liResult.records.map((li) => li.Id)];
        if (allParentIds.length > 0) {
          const idList = allParentIds.map((id) => `'${id}'`).join(',');
          const saResult = await queryAll<ServiceAppointmentRecord>(
            `SELECT Id, AppointmentNumber, ParentRecordId, Status, SchedStartTime, SchedEndTime, ActualStartTime, ActualEndTime ` +
              `FROM ServiceAppointment WHERE ParentRecordId IN (${idList})`,
          );
          saRecords = saResult.records;
        }
        setAppointments(saRecords);

        // Fetch Case if linked
        let fetchedCase: CaseRecord | null = null;
        if (wo.CaseId) {
          const caseResult = await query<CaseRecord>(
            `SELECT Id, CaseNumber, Status, Subject, CreatedDate, ClosedDate ` +
              `FROM Case WHERE Id = '${wo.CaseId}'`,
          );
          fetchedCase = caseResult.records[0] ?? null;
        }
        setCaseRecord(fetchedCase);

        // Fetch Asset if linked
        let fetchedAsset: AssetRecord | null = null;
        if (wo.AssetId) {
          const assetResult = await query<AssetRecord>(
            `SELECT Id, Name, SerialNumber, Status, InstallDate ` +
              `FROM Asset WHERE Id = '${wo.AssetId}'`,
          );
          fetchedAsset = assetResult.records[0] ?? null;
        }
        setAssetRecord(fetchedAsset);

        // Detect bottlenecks
        const detected: Bottleneck[] = [];

        // Overdue work steps
        wsResult.records.forEach((ws) => {
          if (isOverdue(ws.EndDate, ws.Status)) {
            detected.push({
              type: 'overdue',
              severity: 'danger',
              entity: `Work Step #${ws.StepNumber ?? '?'}: ${ws.Name}`,
              message: `Overdue since ${formatDate(ws.EndDate)}`,
              recordId: ws.Id,
            });
          }
        });

        // Overdue line items
        liResult.records.forEach((li) => {
          if (isOverdue(li.EndDate, li.Status)) {
            detected.push({
              type: 'overdue',
              severity: 'warning',
              entity: `Line Item ${li.LineItemNumber}`,
              message: `Overdue since ${formatDate(li.EndDate)}`,
              recordId: li.Id,
            });
          }
        });

        // Unscheduled appointments (line items without SAs)
        const parentIdsWithSA = new Set(saRecords.map((sa) => sa.ParentRecordId));
        liResult.records.forEach((li) => {
          const liStatus = li.Status?.toLowerCase();
          if (
            liStatus !== 'completed' &&
            liStatus !== 'closed' &&
            liStatus !== 'canceled' &&
            liStatus !== 'cancelled' &&
            !parentIdsWithSA.has(li.Id)
          ) {
            detected.push({
              type: 'unscheduled',
              severity: 'warning',
              entity: `Line Item ${li.LineItemNumber}`,
              message: 'No service appointment scheduled',
              recordId: li.Id,
            });
          }
        });

        // DTR sync failures (only check if SAP fields are available)
        if (sapFieldsAvailable) {
          const syncStatus = wo.DTR_Order_SAP_Synchronisation_Status__c?.toLowerCase() ?? '';
          if (syncStatus.includes('error') || syncStatus.includes('fail')) {
            detected.push({
              type: 'sync-failure',
              severity: 'danger',
              entity: `WO ${wo.WorkOrderNumber}`,
              message: `SAP DTR sync failed: ${wo.DTR_Order_SAP_Synchronisation_Status__c}`,
              recordId: wo.Id,
            });
          }
        }

        setBottlenecks(detected);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load related data');
      } finally {
        setLoading(false);
      }
    },
    [sapFieldsAvailable],
  );

  // ── Date Propagation entries ──────────────────────────────────────────────
  const datePropagationEntries: DatePropagationEntry[] = (() => {
    if (!selectedWO) return [];

    const entries: DatePropagationEntry[] = [];

    if (caseRecord) {
      entries.push(
        { entity: 'Case', field: 'Created Date', value: caseRecord.CreatedDate, recordId: caseRecord.Id },
        { entity: 'Case', field: 'Closed Date', value: caseRecord.ClosedDate, recordId: caseRecord.Id },
      );
    }

    if (assetRecord) {
      entries.push({
        entity: 'Asset',
        field: 'Install Date',
        value: assetRecord.InstallDate,
        recordId: assetRecord.Id,
      });
    }

    entries.push(
      { entity: 'Work Order', field: 'Start Date', value: selectedWO.StartDate, recordId: selectedWO.Id },
      { entity: 'Work Order', field: 'End Date', value: selectedWO.EndDate, recordId: selectedWO.Id },
    );

    lineItems.forEach((li) => {
      entries.push(
        { entity: `WOLI ${li.LineItemNumber}`, field: 'Start Date', value: li.StartDate, recordId: li.Id },
        { entity: `WOLI ${li.LineItemNumber}`, field: 'End Date', value: li.EndDate, recordId: li.Id },
      );
    });

    appointments.forEach((sa) => {
      entries.push(
        { entity: `SA ${sa.AppointmentNumber}`, field: 'Sched Start', value: sa.SchedStartTime, recordId: sa.Id },
        { entity: `SA ${sa.AppointmentNumber}`, field: 'Sched End', value: sa.SchedEndTime, recordId: sa.Id },
        { entity: `SA ${sa.AppointmentNumber}`, field: 'Actual Start', value: sa.ActualStartTime, recordId: sa.Id },
        { entity: `SA ${sa.AppointmentNumber}`, field: 'Actual End', value: sa.ActualEndTime, recordId: sa.Id },
      );
    });

    return entries;
  })();

  // ── Bottleneck record ID set (for swimlane highlighting) ──────────────────
  const bottleneckIds = new Set(bottlenecks.map((b) => b.recordId));
  const bottleneckMap = new Map(bottlenecks.map((b) => [b.recordId, b.message]));

  // ── Render helpers for swimlane rows ──────────────────────────────────────
  const renderSwimlaneContent = (key: string) => {
    switch (key) {
      case 'case':
        if (!caseRecord) {
          return <span className="text-xs text-surface-400 dark:text-surface-500 italic">No linked case</span>;
        }
        return (
          <SwimlaneCard
            title={`Case ${caseRecord.CaseNumber}`}
            subtitle={caseRecord.Subject ?? undefined}
            status={caseRecord.Status}
            dates={[
              { label: 'Created', value: caseRecord.CreatedDate },
              { label: 'Closed', value: caseRecord.ClosedDate },
            ]}
            recordId={caseRecord.Id}
            instanceUrl={instanceUrl}
          />
        );

      case 'asset':
        if (!assetRecord) {
          return <span className="text-xs text-surface-400 dark:text-surface-500 italic">No linked asset</span>;
        }
        return (
          <SwimlaneCard
            title={assetRecord.Name}
            subtitle={assetRecord.SerialNumber ? `SN: ${assetRecord.SerialNumber}` : undefined}
            status={assetRecord.Status}
            dates={[{ label: 'Installed', value: assetRecord.InstallDate }]}
            recordId={assetRecord.Id}
            instanceUrl={instanceUrl}
          />
        );

      case 'workorder':
        if (!selectedWO) return null;
        return (
          <SwimlaneCard
            title={`WO ${selectedWO.WorkOrderNumber}`}
            subtitle={selectedWO.Subject ?? undefined}
            status={selectedWO.Status}
            dates={[
              { label: 'Start', value: selectedWO.StartDate },
              { label: 'End', value: selectedWO.EndDate },
            ]}
            recordId={selectedWO.Id}
            instanceUrl={instanceUrl}
            isBottleneck={bottleneckIds.has(selectedWO.Id)}
            bottleneckMessage={bottleneckMap.get(selectedWO.Id)}
          />
        );

      case 'lineitems':
        if (lineItems.length === 0) {
          return <span className="text-xs text-surface-400 dark:text-surface-500 italic">No line items</span>;
        }
        return (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {lineItems.map((li) => (
              <SwimlaneCard
                key={li.Id}
                title={`WOLI ${li.LineItemNumber}`}
                subtitle={li.Subject ?? undefined}
                status={li.Status}
                dates={[
                  { label: 'Start', value: li.StartDate },
                  { label: 'End', value: li.EndDate },
                ]}
                recordId={li.Id}
                instanceUrl={instanceUrl}
                isBottleneck={bottleneckIds.has(li.Id)}
                bottleneckMessage={bottleneckMap.get(li.Id)}
              />
            ))}
          </div>
        );

      case 'worksteps':
        if (workSteps.length === 0) {
          return <span className="text-xs text-surface-400 dark:text-surface-500 italic">No work steps</span>;
        }
        return (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {workSteps.map((ws) => (
              <SwimlaneCard
                key={ws.Id}
                title={`Step ${ws.StepNumber ?? '?'}`}
                subtitle={ws.Name}
                status={ws.Status}
                dates={[
                  { label: 'Start', value: ws.StartDate },
                  { label: 'End', value: ws.EndDate },
                ]}
                recordId={ws.Id}
                instanceUrl={instanceUrl}
                isBottleneck={bottleneckIds.has(ws.Id)}
                bottleneckMessage={bottleneckMap.get(ws.Id)}
              />
            ))}
          </div>
        );

      case 'appointments':
        if (appointments.length === 0) {
          return (
            <span className="text-xs text-surface-400 dark:text-surface-500 italic">
              No service appointments
            </span>
          );
        }
        return (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {appointments.map((sa) => (
              <SwimlaneCard
                key={sa.Id}
                title={`SA ${sa.AppointmentNumber}`}
                status={sa.Status}
                dates={[
                  { label: 'Sched Start', value: sa.SchedStartTime },
                  { label: 'Sched End', value: sa.SchedEndTime },
                  { label: 'Actual Start', value: sa.ActualStartTime },
                  { label: 'Actual End', value: sa.ActualEndTime },
                ]}
                recordId={sa.Id}
                instanceUrl={instanceUrl}
              />
            ))}
          </div>
        );

      case 'sapsync':
        if (!selectedWO) return null;
        return (
          <SwimlaneCard
            title="DTR Order Sync"
            subtitle={selectedWO.SAP_DTR_Order_Reference__c ? `Ref: ${selectedWO.SAP_DTR_Order_Reference__c}` : 'No SAP reference'}
            status={selectedWO.DTR_Order_SAP_Synchronisation_Status__c}
            recordId={selectedWO.Id}
            instanceUrl={instanceUrl}
            isBottleneck={
              selectedWO.DTR_Order_SAP_Synchronisation_Status__c?.toLowerCase().includes('error') ||
              selectedWO.DTR_Order_SAP_Synchronisation_Status__c?.toLowerCase().includes('fail') ||
              false
            }
            bottleneckMessage={
              selectedWO.DTR_Order_SAP_Synchronisation_Status__c?.toLowerCase().includes('error') ||
              selectedWO.DTR_Order_SAP_Synchronisation_Status__c?.toLowerCase().includes('fail')
                ? 'SAP sync failure'
                : undefined
            }
          />
        );

      default:
        return null;
    }
  };

  // ── Date propagation columns ──────────────────────────────────────────────
  const datePropColumns: ColumnDef<DatePropagationEntry, unknown>[] = [
    {
      accessorKey: 'entity',
      header: 'Entity',
      cell: ({ getValue }) => (
        <span className="text-sm font-medium text-surface-800 dark:text-surface-200">
          {getValue<string>()}
        </span>
      ),
    },
    {
      accessorKey: 'field',
      header: 'Date Field',
      cell: ({ getValue }) => (
        <span className="text-sm text-surface-600 dark:text-surface-400">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: 'value',
      header: 'Value',
      cell: ({ getValue }) => {
        const val = getValue<string | null>();
        return (
          <span className={`text-sm font-mono ${val ? 'text-surface-800 dark:text-surface-200' : 'text-surface-400 dark:text-surface-500'}`}>
            {val ? formatDateTime(val) : '\u2014'}
          </span>
        );
      },
    },
    {
      accessorKey: 'recordId',
      header: '',
      cell: ({ getValue }) => (
        <a
          href={sfLink(instanceUrl, getValue<string>())}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-500 hover:text-primary-700 dark:hover:text-primary-300"
          title="Open in Salesforce"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading && workOrders.length === 0 && !selectedWO) {
    return <LoadingSpinner message="Loading work order data..." />;
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary-100 dark:bg-primary-900/30">
            <Truck className="w-6 h-6 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900 dark:text-surface-100">
              Work Order Lifecycle Tracker
            </h1>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Track work orders, line items, steps, appointments, and SAP sync status
            </p>
          </div>
        </div>
      </div>

      {/* ── Error State ─────────────────────────────────────────────────── */}
      {error && (
        <ErrorAlert
          title="Data Fetch Error"
          message={error}
          onRetry={() => {
            if (searchMode === 'single' && searchInput.trim()) handleSearch();
            else if (searchMode === 'batch' && batchFilterValue.trim()) handleBatchLookup();
          }}
        />
      )}

      {/* ── Search Mode Toggle ──────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="inline-flex rounded-lg border border-surface-200 dark:border-surface-700 overflow-hidden self-start">
          <button
            onClick={() => setSearchMode('single')}
            className={`px-4 py-2 text-sm font-medium transition-colors
              ${
                searchMode === 'single'
                  ? 'bg-primary-600 text-white'
                  : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
              }`}
          >
            Single Lookup
          </button>
          <button
            onClick={() => setSearchMode('batch')}
            className={`px-4 py-2 text-sm font-medium transition-colors
              ${
                searchMode === 'batch'
                  ? 'bg-primary-600 text-white'
                  : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
              }`}
          >
            Batch Lookup
          </button>
        </div>

        {/* ── Search Inputs ───────────────────────────────────────────────── */}
        {searchMode === 'single' ? (
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-lg">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
              <input
                type="text"
                placeholder="Work Order Number, Case Number, or Asset Serial..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full pl-9 pr-4 py-2.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           placeholder:text-surface-400 dark:placeholder:text-surface-500
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={loading || !searchInput.trim()}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg
                         bg-primary-600 text-white hover:bg-primary-700
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={batchFilterField}
              onChange={(e) => setBatchFilterField(e.target.value as BatchFilterField)}
              className="px-3 py-2.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                         bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                         focus:outline-none focus:ring-2 focus:ring-primary-500/40"
            >
              <option value="Status">By Status</option>
              <option value="Territory">By Territory</option>
            </select>

            {batchFilterField === 'Status' ? (
              <select
                value={batchFilterValue}
                onChange={(e) => setBatchFilterValue(e.target.value)}
                className="px-3 py-2.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40 min-w-[180px]"
              >
                <option value="">Select status...</option>
                {BATCH_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                placeholder="Territory name..."
                value={batchFilterValue}
                onChange={(e) => setBatchFilterValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleBatchLookup()}
                className="px-3 py-2.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           placeholder:text-surface-400 dark:placeholder:text-surface-500
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40 min-w-[220px]"
              />
            )}

            <button
              onClick={handleBatchLookup}
              disabled={loading || !batchFilterValue.trim()}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg
                         bg-primary-600 text-white hover:bg-primary-700
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Load
            </button>
          </div>
        )}
      </div>

      {/* ── Bottleneck Banner ───────────────────────────────────────────── */}
      {bottlenecks.length > 0 && (
        <div className="flex items-center gap-3 p-4 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <div className="flex-1">
            <span className="text-sm font-semibold text-red-800 dark:text-red-300">
              {bottlenecks.length} bottleneck{bottlenecks.length !== 1 ? 's' : ''} detected
            </span>
            <ul className="mt-1 space-y-0.5">
              {bottlenecks.map((b, i) => (
                <li key={i} className="text-xs text-red-700 dark:text-red-400 flex items-center gap-2">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                      b.severity === 'danger' ? 'bg-red-500' : 'bg-amber-500'
                    }`}
                  />
                  <span className="font-medium">{b.entity}:</span> {b.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── Batch Results Table ──────────────────────────────────────────── */}
      {workOrders.length > 1 && (
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900">
          <div className="flex items-center gap-2 p-4 border-b border-surface-200 dark:border-surface-700">
            <Truck className="w-4 h-4 text-surface-500 dark:text-surface-400" />
            <h2 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
              Work Orders ({workOrders.length})
            </h2>
            <span className="ml-auto text-xs text-surface-400 dark:text-surface-500">
              Click a row to view lifecycle
            </span>
          </div>
          <DataTable
            data={workOrders}
            columns={sapFieldsAvailable ? batchColumns : batchColumns.filter((c) => !('accessorKey' in c && c.accessorKey === 'DTR_Order_SAP_Synchronisation_Status__c'))}
            searchable
            exportable
            exportFilename="work-orders-batch"
            pageSize={20}
            onRowClick={(row) => loadRelatedData(row)}
          />
        </div>
      )}

      {/* ── Visual Swimlane Timeline ────────────────────────────────────── */}
      {selectedWO && (
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-surface-200 dark:border-surface-700">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-surface-500 dark:text-surface-400" />
              <h2 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                Lifecycle Swimlane \u2014 WO {selectedWO.WorkOrderNumber}
              </h2>
            </div>
            {loading && (
              <span className="text-xs text-surface-400 dark:text-surface-500 flex items-center gap-1">
                <RefreshCw className="w-3 h-3 animate-spin" />
                Loading...
              </span>
            )}
          </div>

          <div className="divide-y divide-surface-100 dark:divide-surface-800">
            {swimlaneSections.filter((s) => s.key !== 'sapsync' || sapFieldsAvailable).map((section) => (
              <div key={section.key}>
                {/* Section header */}
                <button
                  onClick={() => toggleSwimlaneSection(section.key)}
                  className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2.5 h-2.5 rounded-sm ${
                        section.key === 'case'
                          ? 'bg-blue-500'
                          : section.key === 'asset'
                            ? 'bg-purple-500'
                            : section.key === 'workorder'
                              ? 'bg-primary-500'
                              : section.key === 'lineitems'
                                ? 'bg-teal-500'
                                : section.key === 'worksteps'
                                  ? 'bg-amber-500'
                                  : section.key === 'appointments'
                                    ? 'bg-emerald-500'
                                    : 'bg-orange-500'
                      }`}
                    />
                    <span className="text-xs font-semibold uppercase tracking-wider text-surface-600 dark:text-surface-400">
                      {section.label}
                    </span>
                    {section.key === 'lineitems' && lineItems.length > 0 && (
                      <span className="text-[10px] text-surface-400 dark:text-surface-500">
                        ({lineItems.length})
                      </span>
                    )}
                    {section.key === 'worksteps' && workSteps.length > 0 && (
                      <span className="text-[10px] text-surface-400 dark:text-surface-500">
                        ({workSteps.length})
                      </span>
                    )}
                    {section.key === 'appointments' && appointments.length > 0 && (
                      <span className="text-[10px] text-surface-400 dark:text-surface-500">
                        ({appointments.length})
                      </span>
                    )}
                  </div>
                  {section.expanded ? (
                    <ChevronUp className="w-4 h-4 text-surface-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-surface-400" />
                  )}
                </button>

                {/* Section content */}
                {section.expanded && (
                  <div className="px-4 pb-4 pt-1">
                    {renderSwimlaneContent(section.key)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Date Propagation View ───────────────────────────────────────── */}
      {selectedWO && (
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 overflow-hidden">
          <button
            onClick={() => setShowDatePropagation(!showDatePropagation)}
            className="w-full flex items-center justify-between p-4 hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-surface-500 dark:text-surface-400" />
              <h2 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                Date Propagation View
              </h2>
              <span className="text-xs text-surface-400 dark:text-surface-500">
                {datePropagationEntries.length} date fields
              </span>
            </div>
            {showDatePropagation ? (
              <ChevronUp className="w-4 h-4 text-surface-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-surface-400" />
            )}
          </button>

          {showDatePropagation && datePropagationEntries.length > 0 && (
            <DataTable
              data={datePropagationEntries}
              columns={datePropColumns}
              searchable={false}
              exportable
              exportFilename={`wo-${selectedWO.WorkOrderNumber}-dates`}
              pageSize={50}
            />
          )}
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {workOrders.length === 0 && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-surface-400 dark:text-surface-500">
          <Truck className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm font-medium">No work orders loaded</p>
          <p className="text-xs mt-1">
            Search by Work Order Number or Case Number, or use Batch Lookup to load multiple records.
          </p>
        </div>
      )}

      {/* ── Single result with no match ──────────────────────────────────── */}
      {workOrders.length === 0 && !loading && error === null && searchInput.trim() !== '' && searchMode === 'single' && (
        <div className="flex flex-col items-center justify-center py-12 text-surface-400 dark:text-surface-500">
          <CheckCircle className="w-10 h-10 mb-2 text-surface-300 dark:text-surface-600" />
          <p className="text-sm">No results found for &quot;{searchInput}&quot;</p>
        </div>
      )}
    </div>
  );
}
