import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  TrendingUp,
  Filter,
} from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { queryAll } from '@/services/salesforce';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimePeriod = '24h' | '7d' | '30d';

type TrafficLight = 'green' | 'yellow' | 'red';

interface IntegrationType {
  key: string;
  label: string;
  messageTypeFilter: string;
}

interface SapTransactLog {
  Id?: string;
  Account__c?: string;
  CPQQuote__c?: string;
  Message__c?: string;
  MessageType__c?: string;
  InvokeType__c?: string;
  CreatedDate: string;
  [key: string]: unknown;
}

interface ErrorLog {
  Id?: string;
  Error_Code__c?: string;
  Error_Message__c?: string;
  Work_Order__c?: string;
  Related_Object_Name__c?: string;
  CreatedDate: string;
  [key: string]: unknown;
}

interface VcLog {
  Id?: string;
  RequestJSON__c?: string;
  ResponseJSON__c?: string;
  Product__c?: string;
  CreatedDate: string;
  [key: string]: unknown;
}

interface KpiStats {
  totalTransactions: number;
  successRate: number;
  failedCount: number;
}

interface IntegrationHealth {
  key: string;
  label: string;
  total: number;
  failed: number;
  successRate: number;
  status: TrafficLight;
}

interface TrendPoint {
  label: string;
  success: number;
  failure: number;
  total: number;
}

interface FailureRow {
  id: string;
  timestamp: string;
  integrationType: string;
  relatedRecord: string;
  errorMessage: string;
  errorCode: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTEGRATION_TYPES: IntegrationType[] = [
  { key: 'quote-sap', label: 'Quote → SAP', messageTypeFilter: 'Quote' },
  { key: 'order-sap', label: 'Order → SAP', messageTypeFilter: 'Order' },
  { key: 'atp-check', label: 'ATP Check', messageTypeFilter: 'ATP' },
  { key: 'equipment-sap', label: 'Equipment → SAP', messageTypeFilter: 'Equipment' },
  { key: 'customer-sap', label: 'Customer → SAP', messageTypeFilter: 'Customer' },
  { key: 'dtr-order-sap', label: 'DTR Order → SAP', messageTypeFilter: 'DTR' },
  { key: 'vc-config', label: 'VC Configuration', messageTypeFilter: 'VC' },
];

const PERIOD_HOURS: Record<TimePeriod, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
};

const PERIOD_LABELS: Record<TimePeriod, string> = {
  '24h': 'Last 24 Hours',
  '7d': 'Last 7 Days',
  '30d': 'Last 30 Days',
};

const DEFAULT_REFRESH_INTERVAL = 60; // seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function soqlDateTimeAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 3600_000);
  return d.toISOString();
}

function computeTrafficLight(successRate: number, total: number): TrafficLight {
  if (total === 0) return 'green';
  if (successRate >= 95) return 'green';
  if (successRate >= 80) return 'yellow';
  return 'red';
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function buildTrendBuckets(
  logs: SapTransactLog[],
  period: TimePeriod,
): TrendPoint[] {
  const now = Date.now();
  const bucketCount = period === '24h' ? 12 : period === '7d' ? 7 : 15;
  const totalMs = PERIOD_HOURS[period] * 3600_000;
  const bucketMs = totalMs / bucketCount;

  const buckets: TrendPoint[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const start = now - totalMs + i * bucketMs;
    const end = start + bucketMs;
    const bucketDate = new Date(start + bucketMs / 2);

    let label: string;
    if (period === '24h') {
      label = bucketDate.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
    } else {
      label = bucketDate.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    }

    const inBucket = logs.filter((l) => {
      const t = new Date(l.CreatedDate).getTime();
      return t >= start && t < end;
    });

    const failed = inBucket.filter(
      (l) =>
        l.MessageType__c?.toLowerCase().includes('error') ||
        l.Message__c?.toLowerCase().includes('error') ||
        l.Message__c?.toLowerCase().includes('fail'),
    ).length;

    buckets.push({
      label,
      success: inBucket.length - failed,
      failure: failed,
      total: inBucket.length,
    });
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// SVG Trend Chart Component
// ---------------------------------------------------------------------------

interface TrendChartProps {
  data: TrendPoint[];
  height?: number;
}

function TrendChart({ data, height = 220 }: TrendChartProps) {
  const paddingLeft = 48;
  const paddingRight = 16;
  const paddingTop = 16;
  const paddingBottom = 48;
  const chartWidth = 700;
  const chartHeight = height;

  const innerW = chartWidth - paddingLeft - paddingRight;
  const innerH = chartHeight - paddingTop - paddingBottom;

  const maxVal = Math.max(1, ...data.map((d) => d.total));
  const yTicks = 5;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-surface-400 dark:text-surface-500 text-sm">
        No data available for trend chart
      </div>
    );
  }

  const barGroupWidth = innerW / data.length;
  const barWidth = Math.max(4, barGroupWidth * 0.35);
  const gap = 2;

  return (
    <svg
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      className="w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Y-axis grid lines and labels */}
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const val = Math.round((maxVal / yTicks) * i);
        const y = paddingTop + innerH - (innerH * i) / yTicks;
        return (
          <g key={i}>
            <line
              x1={paddingLeft}
              y1={y}
              x2={chartWidth - paddingRight}
              y2={y}
              className="stroke-surface-200 dark:stroke-surface-700"
              strokeWidth={1}
            />
            <text
              x={paddingLeft - 8}
              y={y + 4}
              textAnchor="end"
              className="fill-surface-400 dark:fill-surface-500"
              fontSize={11}
            >
              {val}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const groupX = paddingLeft + i * barGroupWidth + barGroupWidth / 2;

        const successH = maxVal > 0 ? (d.success / maxVal) * innerH : 0;
        const failH = maxVal > 0 ? (d.failure / maxVal) * innerH : 0;

        const successX = groupX - barWidth - gap / 2;
        const failX = groupX + gap / 2;

        return (
          <g key={i}>
            {/* Success bar */}
            <rect
              x={successX}
              y={paddingTop + innerH - successH}
              width={barWidth}
              height={successH}
              rx={2}
              className="fill-emerald-500 dark:fill-emerald-400"
              opacity={0.85}
            >
              <title>Success: {d.success}</title>
            </rect>
            {/* Failure bar */}
            <rect
              x={failX}
              y={paddingTop + innerH - failH}
              width={barWidth}
              height={failH}
              rx={2}
              className="fill-red-500 dark:fill-red-400"
              opacity={0.85}
            >
              <title>Failures: {d.failure}</title>
            </rect>
            {/* X-axis label */}
            <text
              x={groupX}
              y={chartHeight - paddingBottom + 18}
              textAnchor="middle"
              className="fill-surface-400 dark:fill-surface-500"
              fontSize={10}
              transform={`rotate(-30, ${groupX}, ${chartHeight - paddingBottom + 18})`}
            >
              {d.label}
            </text>
          </g>
        );
      })}

      {/* Trend line for total */}
      <polyline
        points={data
          .map((d, i) => {
            const x =
              paddingLeft + i * barGroupWidth + barGroupWidth / 2;
            const y =
              paddingTop + innerH - (d.total / maxVal) * innerH;
            return `${x},${y}`;
          })
          .join(' ')}
        fill="none"
        className="stroke-primary-500 dark:stroke-primary-400"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {data.map((d, i) => {
        const x = paddingLeft + i * barGroupWidth + barGroupWidth / 2;
        const y = paddingTop + innerH - (d.total / maxVal) * innerH;
        return (
          <circle
            key={`dot-${i}`}
            cx={x}
            cy={y}
            r={3}
            className="fill-primary-500 dark:fill-primary-400"
          >
            <title>Total: {d.total}</title>
          </circle>
        );
      })}

      {/* Legend */}
      <g transform={`translate(${paddingLeft + 4}, ${paddingTop - 2})`}>
        <rect width={8} height={8} rx={2} className="fill-emerald-500 dark:fill-emerald-400" />
        <text x={12} y={8} fontSize={10} className="fill-surface-500 dark:fill-surface-400">
          Success
        </text>
        <rect x={65} width={8} height={8} rx={2} className="fill-red-500 dark:fill-red-400" />
        <text x={77} y={8} fontSize={10} className="fill-surface-500 dark:fill-surface-400">
          Failures
        </text>
        <line
          x1={130}
          y1={4}
          x2={145}
          y2={4}
          className="stroke-primary-500 dark:stroke-primary-400"
          strokeWidth={2}
        />
        <text x={149} y={8} fontSize={10} className="fill-surface-500 dark:fill-surface-400">
          Total
        </text>
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Failure Drill-Down Table Columns
// ---------------------------------------------------------------------------

const failureColumns: ColumnDef<FailureRow, unknown>[] = [
  {
    accessorKey: 'timestamp',
    header: 'Timestamp',
    cell: ({ getValue }) => (
      <span className="text-xs whitespace-nowrap">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: 'integrationType',
    header: 'Integration',
    cell: ({ getValue }) => (
      <StatusBadge label={getValue<string>()} variant="neutral" />
    ),
  },
  {
    accessorKey: 'relatedRecord',
    header: 'Related Record',
    cell: ({ getValue }) => (
      <span className="text-xs font-mono truncate max-w-[200px] block">
        {getValue<string>() || '—'}
      </span>
    ),
  },
  {
    accessorKey: 'errorCode',
    header: 'Error Code',
    cell: ({ getValue }) => (
      <StatusBadge label={getValue<string>() || 'N/A'} variant="danger" />
    ),
  },
  {
    accessorKey: 'errorMessage',
    header: 'Error Message',
    cell: ({ getValue }) => (
      <span className="text-xs max-w-[350px] block truncate" title={getValue<string>()}>
        {getValue<string>() || '—'}
      </span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function SapMonitor() {
  // ── State ────────────────────────────────────────────────────────────────
  const [period, setPeriod] = useState<TimePeriod>('24h');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  // Data
  const [sapLogs, setSapLogs] = useState<SapTransactLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);
  const [vcLogs, setVcLogs] = useState<VcLog[]>([]);

  // Missing objects warning
  const [missingObjects, setMissingObjects] = useState<string[]>([]);

  // Drill-down
  const [drillDownFilter, setDrillDownFilter] = useState<string | null>(null);

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(DEFAULT_REFRESH_INTERVAL);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data Fetching ────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const since = soqlDateTimeAgo(PERIOD_HOURS[period]);
    const notFound: string[] = [];

    // Query each data source independently so one failure doesn't crash the others
    let sapRecords: SapTransactLog[] = [];
    try {
      const sapResult = await queryAll<SapTransactLog>(
        `SELECT Id, Account__c, CPQQuote__c, Message__c, MessageType__c, InvokeType__c, CreatedDate ` +
          `FROM ensxtx_SAP_Transact_Log__c ` +
          `WHERE CreatedDate >= ${since} ` +
          `ORDER BY CreatedDate DESC`,
      );
      sapRecords = sapResult.records;
    } catch {
      notFound.push('ensxtx_SAP_Transact_Log__c');
    }

    let errorRecords: ErrorLog[] = [];
    try {
      const errorResult = await queryAll<ErrorLog>(
        `SELECT Id, Error_Code__c, Error_Message__c, Work_Order__c, Related_Object_Name__c, CreatedDate ` +
          `FROM Error_Log__c ` +
          `WHERE CreatedDate >= ${since} ` +
          `ORDER BY CreatedDate DESC`,
      );
      errorRecords = errorResult.records;
    } catch {
      notFound.push('Error_Log__c');
    }

    let vcRecords: VcLog[] = [];
    try {
      const vcResult = await queryAll<VcLog>(
        `SELECT Id, RequestJSON__c, ResponseJSON__c, Product__c, CreatedDate ` +
          `FROM ensxtx_VC_Log__c ` +
          `WHERE CreatedDate >= ${since} ` +
          `ORDER BY CreatedDate DESC`,
      );
      vcRecords = vcResult.records;
    } catch {
      notFound.push('ensxtx_VC_Log__c');
    }

    setSapLogs(sapRecords);
    setErrorLogs(errorRecords);
    setVcLogs(vcRecords);
    setMissingObjects(notFound);
    setLastFetchedAt(new Date());
    setLoading(false);
  }, [period]);

  // Initial fetch and re-fetch on period change
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh interval
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchData();
      }, refreshInterval * 1000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, refreshInterval, fetchData]);

  // ── Derived Data ─────────────────────────────────────────────────────────

  const kpi: KpiStats = (() => {
    const total = sapLogs.length + vcLogs.length;
    const failedSap = sapLogs.filter(
      (l) =>
        l.MessageType__c?.toLowerCase().includes('error') ||
        l.Message__c?.toLowerCase().includes('error') ||
        l.Message__c?.toLowerCase().includes('fail'),
    ).length;
    const failedVc = vcLogs.filter(
      (l) =>
        l.ResponseJSON__c?.toLowerCase().includes('error') ||
        l.ResponseJSON__c?.toLowerCase().includes('fail'),
    ).length;
    const failedCount = failedSap + failedVc + errorLogs.length;
    const successRate = total > 0 ? ((total - failedCount) / total) * 100 : 100;

    return {
      totalTransactions: total,
      successRate: Math.max(0, successRate),
      failedCount,
    };
  })();

  const integrationHealth: IntegrationHealth[] = INTEGRATION_TYPES.map((it) => {
    const matchingLogs = sapLogs.filter((l) => {
      const mt = (l.MessageType__c || l.InvokeType__c || '').toLowerCase();
      return mt.includes(it.messageTypeFilter.toLowerCase());
    });

    // VC Configuration also checks VC logs
    const vcCount = it.key === 'vc-config' ? vcLogs.length : 0;
    const total = matchingLogs.length + vcCount;

    const failed = matchingLogs.filter(
      (l) =>
        l.MessageType__c?.toLowerCase().includes('error') ||
        l.Message__c?.toLowerCase().includes('error') ||
        l.Message__c?.toLowerCase().includes('fail'),
    ).length;

    const vcFailed =
      it.key === 'vc-config'
        ? vcLogs.filter(
            (l) =>
              l.ResponseJSON__c?.toLowerCase().includes('error') ||
              l.ResponseJSON__c?.toLowerCase().includes('fail'),
          ).length
        : 0;

    const totalFailed = failed + vcFailed;
    const successRate = total > 0 ? ((total - totalFailed) / total) * 100 : 100;

    return {
      key: it.key,
      label: it.label,
      total,
      failed: totalFailed,
      successRate,
      status: computeTrafficLight(successRate, total),
    };
  });

  const trendData = buildTrendBuckets(sapLogs, period);

  const failureRows: FailureRow[] = (() => {
    const rows: FailureRow[] = [];

    // Failed SAP transactions
    sapLogs
      .filter(
        (l) =>
          l.MessageType__c?.toLowerCase().includes('error') ||
          l.Message__c?.toLowerCase().includes('error') ||
          l.Message__c?.toLowerCase().includes('fail'),
      )
      .forEach((l) => {
        const intType =
          INTEGRATION_TYPES.find((it) =>
            (l.MessageType__c || l.InvokeType__c || '')
              .toLowerCase()
              .includes(it.messageTypeFilter.toLowerCase()),
          )?.label ?? 'Unknown';

        rows.push({
          id: l.Id ?? crypto.randomUUID(),
          timestamp: formatTimestamp(l.CreatedDate),
          integrationType: intType,
          relatedRecord: l.Account__c || l.CPQQuote__c || '',
          errorMessage: l.Message__c || '',
          errorCode: l.MessageType__c || '',
        });
      });

    // Error logs
    errorLogs.forEach((l) => {
      rows.push({
        id: l.Id ?? crypto.randomUUID(),
        timestamp: formatTimestamp(l.CreatedDate),
        integrationType: 'Error Log',
        relatedRecord: l.Related_Object_Name__c || l.Work_Order__c || '',
        errorMessage: l.Error_Message__c || '',
        errorCode: l.Error_Code__c || '',
      });
    });

    // Failed VC logs
    vcLogs
      .filter(
        (l) =>
          l.ResponseJSON__c?.toLowerCase().includes('error') ||
          l.ResponseJSON__c?.toLowerCase().includes('fail'),
      )
      .forEach((l) => {
        rows.push({
          id: l.Id ?? crypto.randomUUID(),
          timestamp: formatTimestamp(l.CreatedDate),
          integrationType: 'VC Configuration',
          relatedRecord: l.Product__c || '',
          errorMessage: l.ResponseJSON__c?.substring(0, 300) || '',
          errorCode: 'VC_ERROR',
        });
      });

    return rows;
  })();

  const filteredFailureRows = drillDownFilter
    ? failureRows.filter(
        (r) =>
          r.integrationType ===
          INTEGRATION_TYPES.find((it) => it.key === drillDownFilter)?.label,
      )
    : failureRows;

  // ── Traffic Light Click Handler ──────────────────────────────────────────

  const handleTrafficLightClick = (ih: IntegrationHealth) => {
    if (ih.status === 'green' && ih.total > 0) return; // no drill-down for green
    if (ih.total === 0) return;
    setDrillDownFilter((prev) => (prev === ih.key ? null : ih.key));
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading && sapLogs.length === 0) {
    return <LoadingSpinner message="Loading SAP integration data..." />;
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary-100 dark:bg-primary-900/30">
            <Activity className="w-6 h-6 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900 dark:text-surface-100">
              SAP Integration Health Monitor
            </h1>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Real-time monitoring of Salesforce ↔ SAP integration transactions
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Last fetched */}
          {lastFetchedAt && (
            <span className="text-xs text-surface-400 dark:text-surface-500 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {lastFetchedAt.toLocaleTimeString()}
            </span>
          )}

          {/* Refresh button */}
          <button
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg
                       bg-primary-600 text-white hover:bg-primary-700
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Error State ─────────────────────────────────────────────────── */}
      {error && (
        <ErrorAlert
          title="Data Fetch Error"
          message={error}
          onRetry={fetchData}
        />
      )}

      {/* ── Missing Objects Warning ────────────────────────────────────── */}
      {missingObjects.length > 0 && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Some integration objects were not found in this org:{' '}
            <span className="font-semibold">{missingObjects.join(', ')}</span>.
            The SAP Monitor requires these custom objects to be installed.
          </p>
        </div>
      )}

      {/* ── Time Period Tabs + Auto-Refresh ─────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="inline-flex rounded-lg border border-surface-200 dark:border-surface-700 overflow-hidden">
          {(['24h', '7d', '30d'] as TimePeriod[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-2 text-sm font-medium transition-colors
                ${
                  period === p
                    ? 'bg-primary-600 text-white'
                    : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
                }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        {/* Auto-refresh toggle */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-surface-600 dark:text-surface-400 cursor-pointer">
            <div className="relative">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-surface-200 dark:bg-surface-700 peer-checked:bg-primary-600 rounded-full transition-colors" />
              <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
            </div>
            Auto-refresh
          </label>
          {autoRefresh && (
            <div className="flex items-center gap-1">
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                className="text-xs rounded-lg border border-surface-200 dark:border-surface-600
                           bg-surface-50 dark:bg-surface-800 text-surface-700 dark:text-surface-300
                           px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                <option value={30}>30s</option>
                <option value={60}>60s</option>
                <option value={120}>2m</option>
                <option value={300}>5m</option>
              </select>
            </div>
          )}
          {loading && sapLogs.length > 0 && (
            <span className="text-xs text-surface-400 dark:text-surface-500 flex items-center gap-1">
              <RefreshCw className="w-3 h-3 animate-spin" />
              Refreshing...
            </span>
          )}
        </div>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Total Transactions */}
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-surface-500 dark:text-surface-400">
              Total Transactions
            </span>
            <TrendingUp className="w-5 h-5 text-primary-500" />
          </div>
          <p className="mt-2 text-3xl font-bold text-surface-900 dark:text-surface-100">
            {kpi.totalTransactions.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-surface-400 dark:text-surface-500">
            {PERIOD_LABELS[period]}
          </p>
        </div>

        {/* Success Rate */}
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-surface-500 dark:text-surface-400">
              Success Rate
            </span>
            <CheckCircle
              className={`w-5 h-5 ${
                kpi.successRate >= 95
                  ? 'text-emerald-500'
                  : kpi.successRate >= 80
                    ? 'text-amber-500'
                    : 'text-red-500'
              }`}
            />
          </div>
          <p
            className={`mt-2 text-3xl font-bold ${
              kpi.successRate >= 95
                ? 'text-emerald-600 dark:text-emerald-400'
                : kpi.successRate >= 80
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-red-600 dark:text-red-400'
            }`}
          >
            {formatPercent(kpi.successRate)}
          </p>
          <p className="mt-1 text-xs text-surface-400 dark:text-surface-500">
            {PERIOD_LABELS[period]}
          </p>
        </div>

        {/* Failed Transactions */}
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-surface-500 dark:text-surface-400">
              Failed Transactions
            </span>
            <XCircle
              className={`w-5 h-5 ${kpi.failedCount > 0 ? 'text-red-500' : 'text-surface-300 dark:text-surface-600'}`}
            />
          </div>
          <p
            className={`mt-2 text-3xl font-bold ${
              kpi.failedCount > 0
                ? 'text-red-600 dark:text-red-400'
                : 'text-surface-900 dark:text-surface-100'
            }`}
          >
            {kpi.failedCount.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-surface-400 dark:text-surface-500">
            {PERIOD_LABELS[period]}
          </p>
        </div>
      </div>

      {/* ── Integration Health Traffic Lights ───────────────────────────── */}
      <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-surface-500 dark:text-surface-400" />
          <h2 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
            Integration Health by Type
          </h2>
          {drillDownFilter && (
            <button
              onClick={() => setDrillDownFilter(null)}
              className="ml-auto text-xs text-primary-600 dark:text-primary-400 hover:underline"
            >
              Clear filter
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {integrationHealth.map((ih) => (
            <button
              key={ih.key}
              onClick={() => handleTrafficLightClick(ih)}
              className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-all
                ${
                  drillDownFilter === ih.key
                    ? 'border-primary-500 ring-2 ring-primary-500/30 bg-primary-50 dark:bg-primary-900/20'
                    : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600 bg-surface-50 dark:bg-surface-800'
                }
                ${ih.status !== 'green' || ih.total === 0 ? 'cursor-pointer' : 'cursor-default'}`}
            >
              {/* Traffic light indicator */}
              <div
                className={`w-4 h-4 rounded-full shadow-sm ${
                  ih.status === 'green'
                    ? 'bg-emerald-500 shadow-emerald-500/40'
                    : ih.status === 'yellow'
                      ? 'bg-amber-500 shadow-amber-500/40 animate-pulse'
                      : 'bg-red-500 shadow-red-500/40 animate-pulse'
                }`}
              />
              <span className="text-xs font-medium text-surface-700 dark:text-surface-300 text-center leading-tight">
                {ih.label}
              </span>
              <span className="text-xs text-surface-400 dark:text-surface-500">
                {ih.total > 0
                  ? `${formatPercent(ih.successRate)} (${ih.total})`
                  : 'No data'}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Trend Chart ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-5">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-surface-500 dark:text-surface-400" />
          <h2 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
            Transaction Trend — {PERIOD_LABELS[period]}
          </h2>
        </div>
        <TrendChart data={trendData} />
      </div>

      {/* ── Failure Drill-Down Table ────────────────────────────────────── */}
      {(drillDownFilter !== null || failureRows.length > 0) && (
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900">
          <div className="flex items-center gap-2 p-4 border-b border-surface-200 dark:border-surface-700">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <h2 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
              Recent Failures
              {drillDownFilter && (
                <span className="ml-2 font-normal text-surface-500 dark:text-surface-400">
                  — filtered to{' '}
                  <span className="font-medium text-primary-600 dark:text-primary-400">
                    {INTEGRATION_TYPES.find((it) => it.key === drillDownFilter)?.label}
                  </span>
                </span>
              )}
            </h2>
            <span className="ml-auto text-xs text-surface-400 dark:text-surface-500">
              {filteredFailureRows.length} record{filteredFailureRows.length !== 1 ? 's' : ''}
            </span>
          </div>

          {filteredFailureRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-surface-400 dark:text-surface-500">
              <CheckCircle className="w-10 h-10 mb-2 text-emerald-400" />
              <p className="text-sm">No failures found for this filter.</p>
            </div>
          ) : (
            <DataTable
              data={filteredFailureRows}
              columns={failureColumns}
              searchable
              exportable
              exportFilename={`sap-failures-${period}`}
              pageSize={15}
            />
          )}
        </div>
      )}
    </div>
  );
}
