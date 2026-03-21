import { useState, useCallback, useMemo } from 'react';
import {
  FileCheck,
  Search,
  RefreshCw,
  Download,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { query } from '@/services/salesforce';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuoteRecord {
  Id: string;
  Name: string;
  SBQQ__Account__r?: {
    Name: string;
    SAP_Account_Number__c?: string;
  };
  SBQQ__Status__c?: string;
  Sales_Org__c?: string;
  Ship_To__c?: string;
  Bill_To__c?: string;
  Payment_Terms__c?: string;
  Delivery_Terms__c?: string;
  Distribution_Channel__c?: string;
  Division__c?: string;
  Price_Violates_MFC__c?: boolean;
  SAP_Connectivity_Error__c?: string;
  ensxtx_SAP_Simulation_Error__c?: string;
  ensxtx_SAP_Consistency_Check__c?: string;
  [key: string]: unknown;
}

interface QuoteLineRecord {
  Id: string;
  SBQQ__Product__r?: { Name: string };
  SBQQ__Quantity__c?: number;
  SBQQ__ListPrice__c?: number;
  SBQQ__NetPrice__c?: number;
  Key_ID_required__c?: boolean;
  Key_ID_Serial_No_Host_ID__c?: string;
  Plant_Determination__c?: string;
  Plant_override__c?: string;
  [key: string]: unknown;
}

interface CheckItem {
  label: string;
  passed: boolean;
  warning?: string;
}

interface Section {
  id: string;
  title: string;
  weight: number;
  checks: CheckItem[];
  expanded: boolean;
}

interface RecentLookup {
  id: string;
  name: string;
  account: string;
  timestamp: Date;
}

interface LookupResult {
  Id: string;
  Name: string;
  SBQQ__Account__r?: { Name: string };
  SBQQ__Status__c?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSectionScore(checks: CheckItem[]): number {
  if (checks.length === 0) return 100;
  const passed = checks.filter((c) => c.passed).length;
  return (passed / checks.length) * 100;
}

function scoreColor(score: number): string {
  if (score > 90) return 'text-green-600 dark:text-green-400';
  if (score >= 70) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function scoreBgColor(score: number): string {
  if (score > 90) return 'bg-green-500';
  if (score >= 70) return 'bg-amber-500';
  return 'bg-red-500';
}

function scoreVariant(score: number): 'success' | 'warning' | 'danger' {
  if (score > 90) return 'success';
  if (score >= 70) return 'warning';
  return 'danger';
}

// ---------------------------------------------------------------------------
// Quote Line Table Columns
// ---------------------------------------------------------------------------

const lineColumns: ColumnDef<QuoteLineRecord, unknown>[] = [
  {
    accessorKey: 'SBQQ__Product__r',
    header: 'Product',
    cell: ({ getValue }) => {
      const val = getValue() as QuoteLineRecord['SBQQ__Product__r'];
      return val?.Name ?? '(no product)';
    },
  },
  {
    accessorKey: 'SBQQ__Quantity__c',
    header: 'Qty',
    cell: ({ getValue }) => {
      const v = getValue() as number | undefined;
      return v != null ? v : '--';
    },
  },
  {
    accessorKey: 'SBQQ__ListPrice__c',
    header: 'List Price',
    cell: ({ getValue }) => {
      const v = getValue() as number | undefined;
      return v != null ? `$${v.toLocaleString()}` : '--';
    },
  },
  {
    accessorKey: 'SBQQ__NetPrice__c',
    header: 'Net Price',
    cell: ({ getValue }) => {
      const v = getValue() as number | undefined;
      return v != null ? `$${v.toLocaleString()}` : '--';
    },
  },
  {
    id: 'keyIdStatus',
    header: 'Key ID',
    cell: ({ row }) => {
      const required = row.original.Key_ID_required__c;
      const value = row.original.Key_ID_Serial_No_Host_ID__c;
      if (!required) return <StatusBadge label="N/A" variant="neutral" />;
      return value ? (
        <StatusBadge label="Set" variant="success" />
      ) : (
        <StatusBadge label="Missing" variant="danger" />
      );
    },
  },
  {
    id: 'plantStatus',
    header: 'Plant',
    cell: ({ row }) => {
      const det = row.original.Plant_Determination__c;
      const ovr = row.original.Plant_override__c;
      const val = ovr || det;
      return val ? (
        <StatusBadge label={val} variant="success" />
      ) : (
        <StatusBadge label="Missing" variant="danger" />
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function QuoteChecker() {
  // Search state
  const [searchInput, setSearchInput] = useState('');
  const [lookupResults, setLookupResults] = useState<LookupResult[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [recentLookups, setRecentLookups] = useState<RecentLookup[]>([]);
  const [showRecents, setShowRecents] = useState(false);

  // Quote state
  const [quoteData, setQuoteData] = useState<QuoteRecord | null>(null);
  const [quoteLines, setQuoteLines] = useState<QuoteLineRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sections collapse state
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    A: true,
    B: true,
    C: true,
    D: true,
  });

  // ── Lookup ─────────────────────────────────────────────────────────────

  const handleLookup = useCallback(async () => {
    const input = searchInput.trim();
    if (!input) return;

    setLookupLoading(true);
    setLookupError(null);
    setLookupResults([]);

    try {
      const sanitized = input.replace(/'/g, "\\'");
      const soql = `SELECT Id, Name, SBQQ__Account__r.Name, SBQQ__Status__c FROM SBQQ__Quote__c WHERE Name = '${sanitized}' OR Id = '${sanitized}' LIMIT 5`;
      const result = await query<LookupResult>(soql);
      setLookupResults(result.records);

      if (result.records.length === 0) {
        setLookupError('No quotes found matching the search criteria.');
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setLookupLoading(false);
    }
  }, [searchInput]);

  // ── Load Full Quote ────────────────────────────────────────────────────

  const loadQuote = useCallback(
    async (quoteId: string, quoteName?: string, accountName?: string) => {
      setLoading(true);
      setError(null);
      setQuoteData(null);
      setQuoteLines([]);
      setLookupResults([]);

      try {
        // Fetch full quote record
        const quoteSoql = `SELECT Id, Name,
          SBQQ__Account__r.Name, SBQQ__Account__r.SAP_Account_Number__c,
          SBQQ__Status__c, Sales_Org__c, Ship_To__c, Bill_To__c,
          Payment_Terms__c, Delivery_Terms__c, Distribution_Channel__c, Division__c,
          Price_Violates_MFC__c,
          SAP_Connectivity_Error__c, ensxtx_SAP_Simulation_Error__c, ensxtx_SAP_Consistency_Check__c
          FROM SBQQ__Quote__c WHERE Id = '${quoteId}' LIMIT 1`;

        const quoteResult = await query<QuoteRecord>(quoteSoql);
        if (quoteResult.records.length === 0) {
          setError('Quote not found.');
          return;
        }

        const q = quoteResult.records[0];
        setQuoteData(q);

        // Add to recent lookups
        setRecentLookups((prev) => {
          const filtered = prev.filter((r) => r.id !== quoteId);
          return [
            {
              id: quoteId,
              name: quoteName ?? q.Name,
              account: accountName ?? q.SBQQ__Account__r?.Name ?? '',
              timestamp: new Date(),
            },
            ...filtered,
          ].slice(0, 10);
        });

        // Fetch quote lines
        const linesSoql = `SELECT Id, SBQQ__Product__r.Name, SBQQ__Quantity__c,
          SBQQ__ListPrice__c, SBQQ__NetPrice__c,
          Key_ID_required__c, Key_ID_Serial_No_Host_ID__c,
          Plant_Determination__c, Plant_override__c
          FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '${quoteId}'`;

        const linesResult = await query<QuoteLineRecord>(linesSoql);
        setQuoteLines(linesResult.records);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load quote');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // ── Completeness Checks ────────────────────────────────────────────────

  const sections: Section[] = useMemo(() => {
    if (!quoteData) return [];

    // Section A - Header Completeness (20% weight)
    const headerChecks: CheckItem[] = [
      {
        label: 'Sales Organization set',
        passed: !!quoteData.Sales_Org__c,
        warning:
          quoteData.Sales_Org__c === '2000'
            ? 'Sales Org "2000" is a legacy ECC value. Verify this is intentional.'
            : undefined,
      },
      {
        label: 'Sold-To Account has SAP number',
        passed: !!quoteData.SBQQ__Account__r?.SAP_Account_Number__c,
      },
      {
        label: 'Ship-To populated',
        passed: !!quoteData.Ship_To__c,
      },
      {
        label: 'Bill-To populated',
        passed: !!quoteData.Bill_To__c,
      },
      {
        label: 'Payment Terms set',
        passed: !!quoteData.Payment_Terms__c,
      },
      {
        label: 'Delivery Terms set',
        passed: !!quoteData.Delivery_Terms__c,
      },
      {
        label: 'Distribution Channel set',
        passed: !!quoteData.Distribution_Channel__c,
      },
      {
        label: 'Division set',
        passed: !!quoteData.Division__c,
      },
    ];

    // Section B - Line Item Validation (40% weight)
    const lineChecks: CheckItem[] = [];
    if (quoteLines.length === 0) {
      lineChecks.push({
        label: 'At least one quote line exists',
        passed: false,
      });
    } else {
      lineChecks.push({
        label: `${quoteLines.length} quote line(s) found`,
        passed: true,
      });

      quoteLines.forEach((line, idx) => {
        const productName = line.SBQQ__Product__r?.Name ?? `Line ${idx + 1}`;

        lineChecks.push({
          label: `${productName}: Product populated`,
          passed: !!line.SBQQ__Product__r?.Name,
        });

        lineChecks.push({
          label: `${productName}: Quantity > 0`,
          passed: (line.SBQQ__Quantity__c ?? 0) > 0,
        });

        lineChecks.push({
          label: `${productName}: Price not zero`,
          passed:
            (line.SBQQ__ListPrice__c ?? 0) !== 0 ||
            (line.SBQQ__NetPrice__c ?? 0) !== 0,
        });

        if (line.Key_ID_required__c) {
          lineChecks.push({
            label: `${productName}: Key ID / Serial No provided`,
            passed: !!line.Key_ID_Serial_No_Host_ID__c,
          });
        }

        lineChecks.push({
          label: `${productName}: Plant determination set`,
          passed: !!(line.Plant_Determination__c || line.Plant_override__c),
        });
      });
    }

    // Section C - Approval Readiness (20% weight)
    const approvalChecks: CheckItem[] = [
      {
        label: 'Price does not violate MFC',
        passed: !quoteData.Price_Violates_MFC__c,
        warning: quoteData.Price_Violates_MFC__c
          ? 'Price violates Most Favored Customer constraints. Approval required.'
          : undefined,
      },
      {
        label: 'Quote status allows submission',
        passed:
          quoteData.SBQQ__Status__c !== 'Rejected' &&
          quoteData.SBQQ__Status__c !== 'Expired',
        warning:
          quoteData.SBQQ__Status__c === 'Rejected' || quoteData.SBQQ__Status__c === 'Expired'
            ? `Quote is in "${quoteData.SBQQ__Status__c}" status.`
            : undefined,
      },
    ];

    // Section D - SAP Readiness (20% weight)
    const sapChecks: CheckItem[] = [
      {
        label: 'No SAP Connectivity Errors',
        passed: !quoteData.SAP_Connectivity_Error__c,
        warning: quoteData.SAP_Connectivity_Error__c
          ? `SAP error: ${quoteData.SAP_Connectivity_Error__c}`
          : undefined,
      },
      {
        label: 'No SAP Simulation Errors',
        passed: !quoteData.ensxtx_SAP_Simulation_Error__c,
        warning: quoteData.ensxtx_SAP_Simulation_Error__c
          ? `Simulation error: ${quoteData.ensxtx_SAP_Simulation_Error__c}`
          : undefined,
      },
      {
        label: 'SAP Consistency Check passed',
        passed:
          !quoteData.ensxtx_SAP_Consistency_Check__c ||
          quoteData.ensxtx_SAP_Consistency_Check__c.toLowerCase() === 'passed' ||
          quoteData.ensxtx_SAP_Consistency_Check__c.toLowerCase() === 'success',
        warning:
          quoteData.ensxtx_SAP_Consistency_Check__c &&
          quoteData.ensxtx_SAP_Consistency_Check__c.toLowerCase() !== 'passed' &&
          quoteData.ensxtx_SAP_Consistency_Check__c.toLowerCase() !== 'success'
            ? `Consistency check: ${quoteData.ensxtx_SAP_Consistency_Check__c}`
            : undefined,
      },
    ];

    return [
      {
        id: 'A',
        title: 'Section A - Header Completeness',
        weight: 0.2,
        checks: headerChecks,
        expanded: expandedSections.A,
      },
      {
        id: 'B',
        title: 'Section B - Line Item Validation',
        weight: 0.4,
        checks: lineChecks,
        expanded: expandedSections.B,
      },
      {
        id: 'C',
        title: 'Section C - Approval Readiness',
        weight: 0.2,
        checks: approvalChecks,
        expanded: expandedSections.C,
      },
      {
        id: 'D',
        title: 'Section D - SAP Readiness',
        weight: 0.2,
        checks: sapChecks,
        expanded: expandedSections.D,
      },
    ];
  }, [quoteData, quoteLines, expandedSections]);

  // ── Overall Score ──────────────────────────────────────────────────────

  const overallScore = useMemo(() => {
    if (sections.length === 0) return 0;
    return sections.reduce((acc, section) => {
      const sectionScore = computeSectionScore(section.checks);
      return acc + sectionScore * section.weight;
    }, 0);
  }, [sections]);

  // ── Toggle Section ─────────────────────────────────────────────────────

  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  }, []);

  // ── Export PDF ─────────────────────────────────────────────────────────

  const exportPdf = useCallback(async () => {
    if (!quoteData) return;

    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 20;

    // Title
    doc.setFontSize(18);
    doc.setTextColor(31, 41, 55);
    doc.text('Quote Completeness Report', pageWidth / 2, y, { align: 'center' });
    y += 10;

    // Quote info
    doc.setFontSize(11);
    doc.setTextColor(107, 114, 128);
    doc.text(`Quote: ${quoteData.Name}`, 14, y);
    y += 6;
    doc.text(`Account: ${quoteData.SBQQ__Account__r?.Name ?? 'N/A'}`, 14, y);
    y += 6;
    doc.text(`Status: ${quoteData.SBQQ__Status__c ?? 'N/A'}`, 14, y);
    y += 6;
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, y);
    y += 10;

    // Overall score
    const scoreLabel = `Overall Score: ${overallScore.toFixed(1)}%`;
    doc.setFontSize(14);
    if (overallScore > 90) doc.setTextColor(22, 163, 74);
    else if (overallScore >= 70) doc.setTextColor(217, 119, 6);
    else doc.setTextColor(220, 38, 38);
    doc.text(scoreLabel, 14, y);
    y += 10;

    // Sections
    doc.setTextColor(31, 41, 55);

    for (const section of sections) {
      // Check if we need a new page
      if (y > 260) {
        doc.addPage();
        y = 20;
      }

      const sScore = computeSectionScore(section.checks);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text(`${section.title} (${section.weight * 100}% weight) - ${sScore.toFixed(1)}%`, 14, y);
      y += 7;

      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');

      for (const check of section.checks) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }

        const icon = check.passed ? '[PASS]' : '[FAIL]';
        if (check.passed) doc.setTextColor(22, 163, 74);
        else doc.setTextColor(220, 38, 38);
        doc.text(icon, 16, y);

        doc.setTextColor(55, 65, 81);
        doc.text(check.label, 32, y);
        y += 5;

        if (check.warning) {
          doc.setTextColor(217, 119, 6);
          const warningLines = doc.splitTextToSize(`Warning: ${check.warning}`, pageWidth - 46);
          doc.text(warningLines, 32, y);
          y += warningLines.length * 4;
        }
      }

      y += 5;
    }

    doc.save(`Quote_Completeness_${quoteData.Name.replace(/\s+/g, '_')}.pdf`);
  }, [quoteData, sections, overallScore]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-100 dark:bg-indigo-900/40">
            <FileCheck className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900 dark:text-surface-50">
              Quote Completeness Checker
            </h1>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Validate CPQ quote configuration readiness for SAP integration
            </p>
          </div>
        </div>
        {quoteData && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadQuote(quoteData.Id, quoteData.Name)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                         border border-surface-200 dark:border-surface-600
                         text-surface-700 dark:text-surface-300
                         hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <button
              onClick={exportPdf}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                         bg-indigo-600 text-white hover:bg-indigo-700
                         dark:bg-indigo-500 dark:hover:bg-indigo-600 transition-colors"
            >
              <Download className="w-4 h-4" />
              Export PDF
            </button>
          </div>
        )}
      </div>

      {/* Search Bar */}
      <div className="bg-white dark:bg-surface-900 rounded-xl border border-surface-200 dark:border-surface-700 p-4">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
              placeholder="Enter Quote ID or Quote Name..."
              className="w-full pl-10 pr-4 py-2.5 text-sm rounded-lg
                         border border-surface-200 dark:border-surface-600
                         bg-surface-50 dark:bg-surface-800
                         text-surface-800 dark:text-surface-200
                         placeholder:text-surface-400
                         focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
          </div>
          <button
            onClick={handleLookup}
            disabled={lookupLoading || !searchInput.trim()}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg
                       bg-indigo-600 text-white hover:bg-indigo-700
                       dark:bg-indigo-500 dark:hover:bg-indigo-600
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {lookupLoading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Lookup
          </button>

          {recentLookups.length > 0 && (
            <button
              onClick={() => setShowRecents(!showRecents)}
              className="flex items-center gap-1 px-3 py-2.5 text-sm rounded-lg
                         border border-surface-200 dark:border-surface-600
                         text-surface-600 dark:text-surface-400
                         hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
            >
              Recent
              {showRecents ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          )}
        </div>

        {/* Recent Lookups Dropdown */}
        {showRecents && recentLookups.length > 0 && (
          <div className="mt-3 border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden">
            {recentLookups.map((recent) => (
              <button
                key={recent.id}
                onClick={() => {
                  setSearchInput(recent.name);
                  setShowRecents(false);
                  loadQuote(recent.id, recent.name, recent.account);
                }}
                className="w-full flex items-center justify-between px-4 py-2.5 text-sm
                           hover:bg-surface-50 dark:hover:bg-surface-800
                           border-b border-surface-100 dark:border-surface-800 last:border-b-0
                           transition-colors text-left"
              >
                <div>
                  <span className="font-medium text-surface-800 dark:text-surface-200">
                    {recent.name}
                  </span>
                  <span className="ml-2 text-surface-400">{recent.account}</span>
                </div>
                <span className="text-xs text-surface-400">
                  {recent.timestamp.toLocaleTimeString()}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Lookup Error */}
        {lookupError && (
          <div className="mt-3">
            <ErrorAlert message={lookupError} onRetry={handleLookup} />
          </div>
        )}

        {/* Lookup Results */}
        {lookupResults.length > 0 && (
          <div className="mt-3 border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-surface-50 dark:bg-surface-800 text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
              Select a quote
            </div>
            {lookupResults.map((result) => (
              <button
                key={result.Id}
                onClick={() =>
                  loadQuote(result.Id, result.Name, result.SBQQ__Account__r?.Name)
                }
                className="w-full flex items-center justify-between px-4 py-3 text-sm
                           hover:bg-indigo-50 dark:hover:bg-indigo-900/20
                           border-t border-surface-100 dark:border-surface-800
                           transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <FileCheck className="w-4 h-4 text-surface-400" />
                  <div>
                    <span className="font-medium text-surface-800 dark:text-surface-200">
                      {result.Name}
                    </span>
                    <span className="ml-2 text-surface-400">
                      {result.SBQQ__Account__r?.Name ?? ''}
                    </span>
                  </div>
                </div>
                <StatusBadge
                  label={result.SBQQ__Status__c ?? 'Draft'}
                  variant={
                    result.SBQQ__Status__c === 'Approved'
                      ? 'success'
                      : result.SBQQ__Status__c === 'Rejected'
                        ? 'danger'
                        : result.SBQQ__Status__c === 'In Review'
                          ? 'warning'
                          : 'neutral'
                  }
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Loading State */}
      {loading && <LoadingSpinner message="Loading quote data and running completeness checks..." />}

      {/* Error State */}
      {error && !loading && (
        <ErrorAlert
          title="Quote Load Error"
          message={error}
          onRetry={quoteData ? () => loadQuote(quoteData.Id) : undefined}
        />
      )}

      {/* Dashboard - Only show when quote is loaded */}
      {quoteData && !loading && !error && (
        <>
          {/* Quote Summary Card */}
          <div className="bg-white dark:bg-surface-900 rounded-xl border border-surface-200 dark:border-surface-700 p-5">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-50">
                  {quoteData.Name}
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400">
                  Account: {quoteData.SBQQ__Account__r?.Name ?? 'N/A'}
                  {quoteData.SBQQ__Account__r?.SAP_Account_Number__c && (
                    <span className="ml-2 text-surface-400">
                      (SAP: {quoteData.SBQQ__Account__r.SAP_Account_Number__c})
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-3 mt-2">
                  <StatusBadge
                    label={quoteData.SBQQ__Status__c ?? 'Draft'}
                    variant={
                      quoteData.SBQQ__Status__c === 'Approved'
                        ? 'success'
                        : quoteData.SBQQ__Status__c === 'Rejected'
                          ? 'danger'
                          : 'neutral'
                    }
                  />
                  {quoteData.Sales_Org__c && (
                    <StatusBadge
                      label={`Sales Org: ${quoteData.Sales_Org__c}`}
                      variant={quoteData.Sales_Org__c === '2000' ? 'warning' : 'info'}
                    />
                  )}
                  <span className="text-xs text-surface-400">
                    {quoteLines.length} line item{quoteLines.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              {/* Overall Score */}
              <div className="text-right">
                <div className={`text-4xl font-bold ${scoreColor(overallScore)}`}>
                  {overallScore.toFixed(1)}%
                </div>
                <div className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                  Overall Completeness
                </div>
                <div className="mt-2">
                  <StatusBadge
                    label={
                      overallScore > 90
                        ? 'Ready'
                        : overallScore >= 70
                          ? 'Needs Attention'
                          : 'Not Ready'
                    }
                    variant={scoreVariant(overallScore)}
                  />
                </div>
              </div>
            </div>

            {/* Score Bar */}
            <div className="mt-4">
              <div className="w-full h-3 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ease-out ${scoreBgColor(overallScore)}`}
                  style={{ width: `${Math.min(overallScore, 100)}%` }}
                />
              </div>
              <div className="flex justify-between mt-1.5 text-xs text-surface-400">
                {sections.map((section) => {
                  const sScore = computeSectionScore(section.checks);
                  return (
                    <span key={section.id} className={scoreColor(sScore)}>
                      {section.id}: {sScore.toFixed(0)}%
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Section Checklists */}
          <div className="space-y-4">
            {sections.map((section) => {
              const sectionScore = computeSectionScore(section.checks);
              const passedCount = section.checks.filter((c) => c.passed).length;
              const totalCount = section.checks.length;

              return (
                <div
                  key={section.id}
                  className="bg-white dark:bg-surface-900 rounded-xl border border-surface-200 dark:border-surface-700 overflow-hidden"
                >
                  {/* Section Header */}
                  <button
                    onClick={() => toggleSection(section.id)}
                    className="w-full flex items-center justify-between px-5 py-4
                               hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${scoreBgColor(sectionScore)}`}
                      />
                      <span className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                        {section.title}
                      </span>
                      <span className="text-xs text-surface-400">
                        ({section.weight * 100}% weight)
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm font-semibold ${scoreColor(sectionScore)}`}>
                        {sectionScore.toFixed(1)}%
                      </span>
                      <span className="text-xs text-surface-400">
                        {passedCount}/{totalCount} passed
                      </span>
                      {section.expanded ? (
                        <ChevronUp className="w-4 h-4 text-surface-400" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-surface-400" />
                      )}
                    </div>
                  </button>

                  {/* Section Checks */}
                  {section.expanded && (
                    <div className="border-t border-surface-100 dark:border-surface-800">
                      {section.checks.map((check, idx) => (
                        <div
                          key={idx}
                          className={`flex items-start gap-3 px-5 py-3
                            ${idx < section.checks.length - 1
                              ? 'border-b border-surface-50 dark:border-surface-800/50'
                              : ''
                            }`}
                        >
                          {check.passed ? (
                            <CheckCircle className="w-4 h-4 text-green-500 dark:text-green-400 mt-0.5 shrink-0" />
                          ) : (
                            <XCircle className="w-4 h-4 text-red-500 dark:text-red-400 mt-0.5 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <span
                              className={`text-sm ${
                                check.passed
                                  ? 'text-surface-600 dark:text-surface-400'
                                  : 'text-surface-800 dark:text-surface-200 font-medium'
                              }`}
                            >
                              {check.label}
                            </span>
                            {check.warning && (
                              <div className="flex items-center gap-1.5 mt-1">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                <span className="text-xs text-amber-600 dark:text-amber-400">
                                  {check.warning}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Quote Lines Table */}
          {quoteLines.length > 0 && (
            <DataTable
              data={quoteLines}
              columns={lineColumns}
              title="Quote Line Items"
              searchable
              exportable
              exportFilename={`QuoteLines_${quoteData.Name.replace(/\s+/g, '_')}`}
              pageSize={25}
            />
          )}
        </>
      )}

      {/* Empty State */}
      {!quoteData && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="p-4 rounded-2xl bg-surface-100 dark:bg-surface-800 mb-4">
            <FileCheck className="w-10 h-10 text-surface-400" />
          </div>
          <h3 className="text-lg font-semibold text-surface-700 dark:text-surface-300 mb-1">
            No quote loaded
          </h3>
          <p className="text-sm text-surface-400 max-w-md">
            Enter a Quote ID or Name above and click Lookup to run a completeness check.
            The checker validates header fields, line items, approval readiness, and SAP
            integration status.
          </p>
        </div>
      )}
    </div>
  );
}
