import { useState, useCallback, useRef } from 'react';
import {
  Upload,
  FileSpreadsheet,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  Download,
  Play,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { useAppStore } from '@/services/store';
import { describe, composite } from '@/services/salesforce';
import { saveAs } from 'file-saver';
import type { ColumnDef } from '@tanstack/react-table';
import type {
  SalesforceDescribeResult,
  SalesforceFieldDescribe,
  SalesforceCompositeRequest,
} from '@/services/salesforce';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FSL_OBJECTS = [
  'WorkType',
  'ServiceTerritory',
  'OperatingHours',
  'Skill',
  'SkillRequirement',
  'ServiceResource',
  'ServiceTerritoryMember',
] as const;

type FslObject = (typeof FSL_OBJECTS)[number];

/** Loading order: parent objects before children. */
const LOAD_ORDER: FslObject[] = [
  'OperatingHours',
  'ServiceTerritory',
  'WorkType',
  'Skill',
  'ServiceResource',
  'SkillRequirement',
  'ServiceTerritoryMember',
];

const STEPS = ['Upload', 'Mapping', 'Validation', 'Preview', 'Push', 'Results'] as const;
type Step = (typeof STEPS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, unknown>[];
}

interface ColumnMapping {
  excelColumn: string;
  sfField: string;
  fieldType: string;
  required: boolean;
  referenceTo: string[];
}

interface SheetMapping {
  sheetName: string;
  sfObject: FslObject | '';
  columns: ColumnMapping[];
  sfDescribe: SalesforceDescribeResult | null;
}

interface ValidationRow {
  rowIndex: number;
  status: 'pass' | 'fail' | 'warning';
  errors: string[];
  warnings: string[];
  data: Record<string, unknown>;
}

interface ValidationResult {
  sheetName: string;
  sfObject: FslObject;
  rows: ValidationRow[];
  passCount: number;
  failCount: number;
  warningCount: number;
}

interface PushRowResult {
  rowIndex: number;
  sfObject: string;
  operation: 'create' | 'update';
  success: boolean;
  recordId?: string;
  error?: string;
  data: Record<string, unknown>;
}

interface PushSummary {
  created: number;
  updated: number;
  failed: number;
  results: PushRowResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a header string for fuzzy matching. */
function normalise(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

/** Try to auto-match an Excel column header to a Salesforce field name. */
function autoMatchField(
  header: string,
  sfFields: SalesforceFieldDescribe[],
): SalesforceFieldDescribe | undefined {
  const normHeader = normalise(header);

  // Exact match on API name
  const exactApi = sfFields.find((f) => normalise(f.name) === normHeader);
  if (exactApi) return exactApi;

  // Exact match on label
  const exactLabel = sfFields.find((f) => normalise(f.label) === normHeader);
  if (exactLabel) return exactLabel;

  // Substring / contains
  const contains = sfFields.find(
    (f) => normalise(f.name).includes(normHeader) || normHeader.includes(normalise(f.name)),
  );
  if (contains) return contains;

  return undefined;
}

/** Map Salesforce field type to a simpler display type. */
function simplifyType(sfType: string): string {
  switch (sfType) {
    case 'string':
    case 'textarea':
    case 'url':
    case 'email':
    case 'phone':
    case 'picklist':
    case 'multipicklist':
    case 'combobox':
    case 'encryptedstring':
      return 'text';
    case 'int':
    case 'double':
    case 'currency':
    case 'percent':
      return 'number';
    case 'date':
    case 'datetime':
    case 'time':
      return 'date';
    case 'boolean':
      return 'boolean';
    case 'reference':
      return 'lookup';
    case 'id':
      return 'id';
    default:
      return sfType;
  }
}

/** Coerce a cell value to match the expected Salesforce type. */
function coerceValue(value: unknown, sfType: string): unknown {
  if (value === null || value === undefined || value === '') return null;

  switch (sfType) {
    case 'int':
      return typeof value === 'number' ? Math.floor(value) : parseInt(String(value), 10) || null;
    case 'double':
    case 'currency':
    case 'percent':
      return typeof value === 'number' ? value : parseFloat(String(value)) || null;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return ['true', '1', 'yes'].includes(String(value).toLowerCase());
    case 'date': {
      if (typeof value === 'number') {
        // Excel serial date
        const d = XLSX.SSF.parse_date_code(value);
        if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
      }
      return String(value);
    }
    case 'datetime': {
      if (typeof value === 'number') {
        const d = XLSX.SSF.parse_date_code(value);
        if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}T00:00:00.000Z`;
      }
      return String(value);
    }
    default:
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FslLoader() {
  const { auth } = useAppStore();

  // ── Wizard state ─────────────────────────────────────────────────────
  const [currentStep, setCurrentStep] = useState<Step>('Upload');
  const currentStepIndex = STEPS.indexOf(currentStep);

  // ── Upload step ──────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [previewSheet, setPreviewSheet] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // ── Mapping step ─────────────────────────────────────────────────────
  const [mappings, setMappings] = useState<SheetMapping[]>([]);
  const [describingObj, setDescribingObj] = useState<string | null>(null);

  // ── Validation step ──────────────────────────────────────────────────
  const [validationResults, setValidationResults] = useState<ValidationResult[]>([]);
  const [validating, setValidating] = useState(false);

  // ── Push step ────────────────────────────────────────────────────────
  const [pushing, setPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState({ current: 0, total: 0, label: '' });
  const [pushSummary, setPushSummary] = useState<PushSummary | null>(null);

  // ── General ──────────────────────────────────────────────────────────
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Keep a map of created record IDs for cross-object lookups
  const createdIdsRef = useRef<Map<string, Map<string, string>>>(new Map());

  // =====================================================================
  // Upload handlers
  // =====================================================================

  const parseFile = useCallback((file: File) => {
    setError(null);
    setFileName(file.name);
    setLoading(true);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array', cellDates: false });

        const parsed: ParsedSheet[] = workbook.SheetNames.map((name) => {
          const ws = workbook.Sheets[name];
          const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
          const headers = json.length > 0 ? Object.keys(json[0]) : [];
          return { name, headers, rows: json };
        });

        setSheets(parsed);
        setPreviewSheet(parsed.length > 0 ? parsed[0].name : null);

        // Initialise mappings
        setMappings(
          parsed.map((s) => ({
            sheetName: s.name,
            sfObject: '',
            columns: s.headers.map((h) => ({
              excelColumn: h,
              sfField: '',
              fieldType: '',
              required: false,
              referenceTo: [],
            })),
            sfDescribe: null,
          })),
        );
      } catch (err) {
        setError(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    };

    reader.onerror = () => {
      setError('Failed to read file.');
      setLoading(false);
    };

    reader.readAsArrayBuffer(file);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) parseFile(file);
    },
    [parseFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) parseFile(file);
    },
    [parseFile],
  );

  // =====================================================================
  // Mapping handlers
  // =====================================================================

  const handleObjectSelect = useCallback(
    async (sheetIndex: number, objName: string) => {
      setError(null);
      const obj = objName as FslObject | '';
      setMappings((prev) => {
        const next = [...prev];
        next[sheetIndex] = { ...next[sheetIndex], sfObject: obj, sfDescribe: null };
        return next;
      });

      if (!obj) return;

      setDescribingObj(obj);
      try {
        const desc = await describe(obj);
        const createableFields = desc.fields.filter((f) => f.createable || f.updateable);
        const sheet = sheets[sheetIndex];

        setMappings((prev) => {
          const next = [...prev];
          next[sheetIndex] = {
            ...next[sheetIndex],
            sfDescribe: desc,
            columns: sheet.headers.map((h) => {
              const matched = autoMatchField(h, createableFields);
              return {
                excelColumn: h,
                sfField: matched?.name ?? '',
                fieldType: matched ? simplifyType(matched.type) : '',
                required: matched ? !matched.nillable && matched.createable : false,
                referenceTo: matched?.referenceTo ?? [],
              };
            }),
          };
          return next;
        });
      } catch (err) {
        setError(`Failed to describe ${obj}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setDescribingObj(null);
      }
    },
    [sheets],
  );

  const handleFieldMapping = useCallback(
    (sheetIndex: number, colIndex: number, sfFieldName: string) => {
      setMappings((prev) => {
        const next = [...prev];
        const mapping = { ...next[sheetIndex] };
        const columns = [...mapping.columns];
        const desc = mapping.sfDescribe;

        if (desc && sfFieldName) {
          const field = desc.fields.find((f) => f.name === sfFieldName);
          columns[colIndex] = {
            ...columns[colIndex],
            sfField: sfFieldName,
            fieldType: field ? simplifyType(field.type) : '',
            required: field ? !field.nillable && field.createable : false,
            referenceTo: field?.referenceTo ?? [],
          };
        } else {
          columns[colIndex] = {
            ...columns[colIndex],
            sfField: '',
            fieldType: '',
            required: false,
            referenceTo: [],
          };
        }

        mapping.columns = columns;
        next[sheetIndex] = mapping;
        return next;
      });
    },
    [],
  );

  // =====================================================================
  // Validation
  // =====================================================================

  const runValidation = useCallback(async () => {
    setError(null);
    setValidating(true);

    try {
      const activeMappings = mappings.filter((m) => m.sfObject !== '');
      const results: ValidationResult[] = [];

      // Check loading sequence
      const mappedObjects = activeMappings.map((m) => m.sfObject as FslObject);
      const orderedObjects = LOAD_ORDER.filter((o) => mappedObjects.includes(o));

      for (const mapping of activeMappings) {
        const sheet = sheets.find((s) => s.name === mapping.sheetName);
        if (!sheet) continue;

        const activeColumns = mapping.columns.filter((c) => c.sfField !== '');
        const rows: ValidationRow[] = [];

        for (let i = 0; i < sheet.rows.length; i++) {
          const row = sheet.rows[i];
          const errors: string[] = [];
          const warnings: string[] = [];

          // Required field checks
          for (const col of activeColumns) {
            if (col.required) {
              const val = row[col.excelColumn];
              if (val === null || val === undefined || val === '') {
                errors.push(`Required field "${col.sfField}" is empty`);
              }
            }
          }

          // Type validation
          for (const col of activeColumns) {
            const val = row[col.excelColumn];
            if (val === null || val === undefined || val === '') continue;

            if (col.fieldType === 'number') {
              const num = Number(val);
              if (isNaN(num)) {
                errors.push(`"${col.excelColumn}" must be a number, got "${val}"`);
              }
            }

            if (col.fieldType === 'date') {
              if (typeof val !== 'number') {
                const d = new Date(String(val));
                if (isNaN(d.getTime())) {
                  errors.push(`"${col.excelColumn}" must be a valid date, got "${val}"`);
                }
              }
            }

            if (col.fieldType === 'boolean') {
              const s = String(val).toLowerCase();
              if (!['true', 'false', '1', '0', 'yes', 'no'].includes(s)) {
                warnings.push(`"${col.excelColumn}" value "${val}" will be coerced to boolean`);
              }
            }
          }

          // Lookup validation: check if referenced objects are in load order before this one
          for (const col of activeColumns) {
            if (col.fieldType === 'lookup' && col.referenceTo.length > 0) {
              for (const refObj of col.referenceTo) {
                const refFsl = refObj as FslObject;
                if (orderedObjects.includes(refFsl)) {
                  const refIdx = orderedObjects.indexOf(refFsl);
                  const thisIdx = orderedObjects.indexOf(mapping.sfObject as FslObject);
                  if (refIdx > thisIdx) {
                    warnings.push(
                      `"${col.sfField}" references ${refObj} which is loaded after ${mapping.sfObject}`,
                    );
                  }
                }
              }
            }
          }

          const mappedData: Record<string, unknown> = {};
          for (const col of activeColumns) {
            const sfField = mapping.sfDescribe?.fields.find((f) => f.name === col.sfField);
            mappedData[col.sfField] = coerceValue(row[col.excelColumn], sfField?.type ?? 'string');
          }

          rows.push({
            rowIndex: i + 1,
            status: errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warning' : 'pass',
            errors,
            warnings,
            data: mappedData,
          });
        }

        results.push({
          sheetName: mapping.sheetName,
          sfObject: mapping.sfObject as FslObject,
          rows,
          passCount: rows.filter((r) => r.status === 'pass').length,
          failCount: rows.filter((r) => r.status === 'fail').length,
          warningCount: rows.filter((r) => r.status === 'warning').length,
        });
      }

      setValidationResults(results);
    } catch (err) {
      setError(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setValidating(false);
    }
  }, [mappings, sheets]);

  // =====================================================================
  // Push to Salesforce
  // =====================================================================

  const pushToSalesforce = useCallback(async () => {
    setError(null);
    setPushing(true);
    createdIdsRef.current = new Map();

    const allResults: PushRowResult[] = [];
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalFailed = 0;

    // Process in load order
    const orderedResults = [...validationResults].sort((a, b) => {
      return LOAD_ORDER.indexOf(a.sfObject) - LOAD_ORDER.indexOf(b.sfObject);
    });

    const totalRows = orderedResults.reduce(
      (sum, vr) => sum + vr.rows.filter((r) => r.status !== 'fail').length,
      0,
    );
    let processedRows = 0;

    for (const vr of orderedResults) {
      const validRows = vr.rows.filter((r) => r.status !== 'fail');
      if (validRows.length === 0) continue;

      // Process in batches of 25 (Composite API limit)
      const batchSize = 25;
      for (let batchStart = 0; batchStart < validRows.length; batchStart += batchSize) {
        const batch = validRows.slice(batchStart, batchStart + batchSize);

        const compositeRequests: SalesforceCompositeRequest[] = batch.map((row, idx) => {
          const cleanData = { ...row.data };

          // Resolve lookup references: if a lookup field references an FSL object
          // that was already loaded, try to find the created record ID
          for (const [fieldName, fieldValue] of Object.entries(cleanData)) {
            if (fieldValue && typeof fieldValue === 'string') {
              // Check if there's a matching created record by name
              for (const [_objName, idMap] of createdIdsRef.current.entries()) {
                const matchedId = idMap.get(String(fieldValue));
                if (matchedId) {
                  cleanData[fieldName] = matchedId;
                }
              }
            }
          }

          // Remove null fields
          for (const key of Object.keys(cleanData)) {
            if (cleanData[key] === null) delete cleanData[key];
          }

          const hasId = cleanData.Id && typeof cleanData.Id === 'string' && cleanData.Id.length >= 15;

          if (hasId) {
            const id = cleanData.Id as string;
            delete cleanData.Id;
            return {
              method: 'PATCH' as const,
              url: `/services/data/v62.0/sobjects/${vr.sfObject}/${id}`,
              referenceId: `ref_${vr.sfObject}_${batchStart + idx}`,
              body: cleanData,
            };
          }

          return {
            method: 'POST' as const,
            url: `/services/data/v62.0/sobjects/${vr.sfObject}`,
            referenceId: `ref_${vr.sfObject}_${batchStart + idx}`,
            body: cleanData,
          };
        });

        setPushProgress({
          current: processedRows,
          total: totalRows,
          label: `Loading ${vr.sfObject}...`,
        });

        try {
          const response = await composite(compositeRequests);

          for (let i = 0; i < response.compositeResponse.length; i++) {
            const subResponse = response.compositeResponse[i];
            const row = batch[i];
            const isSuccess = subResponse.httpStatusCode >= 200 && subResponse.httpStatusCode < 300;
            const isCreate = compositeRequests[i].method === 'POST';

            if (isSuccess) {
              if (isCreate) {
                totalCreated++;
                // Store created ID for lookup resolution
                const body = subResponse.body as { id?: string } | undefined;
                if (body?.id) {
                  if (!createdIdsRef.current.has(vr.sfObject)) {
                    createdIdsRef.current.set(vr.sfObject, new Map());
                  }
                  // Store by Name field if present
                  const nameVal = row.data.Name ?? row.data.DeveloperName ?? '';
                  if (nameVal) {
                    createdIdsRef.current.get(vr.sfObject)!.set(String(nameVal), body.id);
                  }
                }
              } else {
                totalUpdated++;
              }
            } else {
              totalFailed++;
            }

            allResults.push({
              rowIndex: row.rowIndex,
              sfObject: vr.sfObject,
              operation: isCreate ? 'create' : 'update',
              success: isSuccess,
              recordId: isSuccess
                ? (subResponse.body as { id?: string })?.id ?? compositeRequests[i].url.split('/').pop()
                : undefined,
              error: !isSuccess
                ? JSON.stringify(subResponse.body)
                : undefined,
              data: row.data,
            });

            processedRows++;
          }
        } catch (err) {
          // Entire batch failed
          for (const row of batch) {
            totalFailed++;
            allResults.push({
              rowIndex: row.rowIndex,
              sfObject: vr.sfObject,
              operation: 'create',
              success: false,
              error: err instanceof Error ? err.message : String(err),
              data: row.data,
            });
            processedRows++;
          }
        }

        setPushProgress({ current: processedRows, total: totalRows, label: `Loading ${vr.sfObject}...` });
      }
    }

    setPushSummary({
      created: totalCreated,
      updated: totalUpdated,
      failed: totalFailed,
      results: allResults,
    });
    setPushing(false);
    setCurrentStep('Results');
  }, [validationResults]);

  // =====================================================================
  // Export error report
  // =====================================================================

  const downloadErrorReport = useCallback(() => {
    if (!pushSummary) return;

    const failedRows = pushSummary.results.filter((r) => !r.success);
    if (failedRows.length === 0) return;

    const headers = ['Row', 'Object', 'Operation', 'Error', ...Object.keys(failedRows[0].data)];
    const csvRows = failedRows.map((r) => [
      r.rowIndex,
      r.sfObject,
      r.operation,
      `"${(r.error ?? '').replace(/"/g, '""')}"`,
      ...Object.values(r.data).map((v) => {
        const s = v == null ? '' : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }),
    ]);

    const csv = [headers.join(','), ...csvRows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, 'fsl-load-errors.csv');
  }, [pushSummary]);

  // =====================================================================
  // Navigation
  // =====================================================================

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 'Upload':
        return sheets.length > 0;
      case 'Mapping':
        return mappings.some((m) => m.sfObject !== '' && m.columns.some((c) => c.sfField !== ''));
      case 'Validation':
        return validationResults.length > 0 && validationResults.some((vr) => vr.passCount > 0);
      case 'Preview':
        return true;
      case 'Push':
        return !pushing;
      case 'Results':
        return false;
      default:
        return false;
    }
  };

  const goNext = () => {
    const idx = STEPS.indexOf(currentStep);
    if (idx < STEPS.length - 1) {
      const nextStep = STEPS[idx + 1];
      if (nextStep === 'Validation') {
        runValidation();
      }
      setCurrentStep(nextStep);
    }
  };

  const goBack = () => {
    const idx = STEPS.indexOf(currentStep);
    if (idx > 0) {
      setCurrentStep(STEPS[idx - 1]);
    }
  };

  const resetWizard = () => {
    setCurrentStep('Upload');
    setFileName(null);
    setSheets([]);
    setPreviewSheet(null);
    setMappings([]);
    setValidationResults([]);
    setPushSummary(null);
    setPushProgress({ current: 0, total: 0, label: '' });
    setError(null);
    createdIdsRef.current = new Map();
  };

  // =====================================================================
  // Preview computations
  // =====================================================================

  const previewSummary = validationResults.map((vr) => ({
    sfObject: vr.sfObject,
    toCreate: vr.rows.filter((r) => r.status !== 'fail' && !r.data.Id).length,
    toUpdate: vr.rows.filter((r) => r.status !== 'fail' && r.data.Id).length,
    skipped: vr.rows.filter((r) => r.status === 'fail').length,
  }));

  // =====================================================================
  // Render
  // =====================================================================

  return (
    <div className="h-full flex flex-col gap-4 p-4 overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center">
            <FileSpreadsheet className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-surface-900 dark:text-surface-50">
              FSL Data Loader
            </h1>
            <p className="text-xs text-surface-500 dark:text-surface-400">
              Load Field Service Lightning configuration data from Excel/CSV
            </p>
          </div>
        </div>
        <button
          onClick={resetWizard}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg
                     text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Reset
        </button>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 bg-surface-50 dark:bg-surface-800/50 rounded-xl p-2">
        {STEPS.map((step, idx) => {
          const isActive = idx === currentStepIndex;
          const isPast = idx < currentStepIndex;
          return (
            <div key={step} className="flex items-center flex-1">
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex-1
                  ${isActive
                    ? 'bg-primary-500 text-white shadow-sm'
                    : isPast
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                      : 'text-surface-400 dark:text-surface-500'
                  }`}
              >
                {isPast ? (
                  <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <span className="w-4 h-4 shrink-0 rounded-full border border-current flex items-center justify-center text-[10px]">
                    {idx + 1}
                  </span>
                )}
                <span className="truncate">{step}</span>
              </div>
              {idx < STEPS.length - 1 && (
                <ArrowRight className="w-3.5 h-3.5 text-surface-300 dark:text-surface-600 mx-1 shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      {/* Error banner */}
      {error && <ErrorAlert message={error} onRetry={() => setError(null)} />}

      {/* Step content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* ─── Step 1: Upload ─────────────────────────────────────────── */}
        {currentStep === 'Upload' && (
          <div className="space-y-4">
            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors
                ${dragOver
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                  : 'border-surface-300 dark:border-surface-600 hover:border-primary-400 dark:hover:border-primary-500 bg-surface-50 dark:bg-surface-800/50'
                }`}
            >
              <Upload className={`w-10 h-10 ${dragOver ? 'text-primary-500' : 'text-surface-400'}`} />
              <div className="text-center">
                <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                  {fileName ? fileName : 'Drop an Excel or CSV file here, or click to browse'}
                </p>
                <p className="text-xs text-surface-400 mt-1">
                  Supports .xlsx, .xls, .csv formats
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            {loading && <LoadingSpinner message="Parsing file..." />}

            {/* Detected sheets */}
            {sheets.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                  Detected Sheets ({sheets.length})
                </h3>
                <div className="flex gap-2 flex-wrap">
                  {sheets.map((s) => (
                    <button
                      key={s.name}
                      onClick={() => setPreviewSheet(s.name)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                        ${previewSheet === s.name
                          ? 'bg-primary-500 text-white'
                          : 'bg-surface-100 dark:bg-surface-700 text-surface-700 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-600'
                        }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        {s.name}
                        <span className="text-xs opacity-60">({s.rows.length} rows)</span>
                      </span>
                    </button>
                  ))}
                </div>

                {/* Sheet preview */}
                {previewSheet && (() => {
                  const sheet = sheets.find((s) => s.name === previewSheet);
                  if (!sheet || sheet.rows.length === 0) return null;

                  const previewColumns: ColumnDef<Record<string, unknown>, unknown>[] = sheet.headers.map(
                    (h) => ({
                      id: h,
                      accessorKey: h,
                      header: h,
                      cell: ({ getValue }) => {
                        const v = getValue();
                        return <span className="truncate max-w-[200px] block">{v == null ? '' : String(v)}</span>;
                      },
                    }),
                  );

                  return (
                    <DataTable
                      data={sheet.rows.slice(0, 100)}
                      columns={previewColumns}
                      title={`Preview: ${sheet.name}`}
                      pageSize={10}
                      exportable={false}
                    />
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* ─── Step 2: Mapping ────────────────────────────────────────── */}
        {currentStep === 'Mapping' && (
          <div className="space-y-6">
            {mappings.map((mapping, sheetIdx) => (
              <div
                key={mapping.sheetName}
                className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden"
              >
                {/* Sheet header */}
                <div className="flex items-center justify-between p-4 bg-surface-50 dark:bg-surface-800/50 border-b border-surface-200 dark:border-surface-700">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="w-4 h-4 text-surface-500" />
                    <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                      {mapping.sheetName}
                    </h3>
                    <span className="text-xs text-surface-400">
                      ({sheets.find((s) => s.name === mapping.sheetName)?.rows.length ?? 0} rows)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-surface-500 dark:text-surface-400">
                      Salesforce Object:
                    </label>
                    <select
                      value={mapping.sfObject}
                      onChange={(e) => handleObjectSelect(sheetIdx, e.target.value)}
                      className="text-sm rounded-lg border border-surface-200 dark:border-surface-600
                                 bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                                 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                    >
                      <option value="">-- Select Object --</option>
                      {FSL_OBJECTS.map((obj) => (
                        <option key={obj} value={obj}>
                          {obj}
                        </option>
                      ))}
                    </select>
                    {describingObj === mapping.sfObject && (
                      <RefreshCw className="w-4 h-4 text-primary-500 animate-spin" />
                    )}
                  </div>
                </div>

                {/* Column mapping table */}
                {mapping.sfObject && mapping.sfDescribe && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-surface-200 dark:border-surface-700">
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                            Excel Column
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                            Salesforce Field
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                            Type
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                            Required
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {mapping.columns.map((col, colIdx) => (
                          <tr
                            key={col.excelColumn}
                            className="border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50"
                          >
                            <td className="px-4 py-2 text-surface-700 dark:text-surface-300 font-mono text-xs">
                              {col.excelColumn}
                            </td>
                            <td className="px-4 py-2">
                              <select
                                value={col.sfField}
                                onChange={(e) => handleFieldMapping(sheetIdx, colIdx, e.target.value)}
                                className={`text-xs rounded-lg border px-2 py-1 w-full max-w-[280px]
                                           focus:outline-none focus:ring-2 focus:ring-primary-500/40
                                  ${col.sfField
                                    ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 text-surface-800 dark:text-surface-200'
                                    : 'border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200'
                                  }`}
                              >
                                <option value="">-- Skip --</option>
                                {mapping.sfDescribe!.fields
                                  .filter((f) => f.createable || f.updateable)
                                  .sort((a, b) => a.label.localeCompare(b.label))
                                  .map((f) => (
                                    <option key={f.name} value={f.name}>
                                      {f.label} ({f.name})
                                    </option>
                                  ))}
                              </select>
                            </td>
                            <td className="px-4 py-2">
                              {col.fieldType && (
                                <StatusBadge
                                  label={col.fieldType}
                                  variant={
                                    col.fieldType === 'lookup'
                                      ? 'info'
                                      : col.fieldType === 'number'
                                        ? 'warning'
                                        : col.fieldType === 'date'
                                          ? 'success'
                                          : 'neutral'
                                  }
                                />
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {col.required && (
                                <span className="text-red-500 dark:text-red-400 text-xs font-medium">
                                  Required
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {mapping.sfObject && !mapping.sfDescribe && describingObj === mapping.sfObject && (
                  <div className="p-6">
                    <LoadingSpinner message={`Describing ${mapping.sfObject}...`} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ─── Step 3: Validation ─────────────────────────────────────── */}
        {currentStep === 'Validation' && (
          <div className="space-y-4">
            {validating && <LoadingSpinner message="Validating data..." />}

            {!validating && validationResults.length === 0 && (
              <div className="text-center py-10 text-surface-400 dark:text-surface-500">
                <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
                <p className="text-sm">No validation results yet. Click Next on the Mapping step to validate.</p>
              </div>
            )}

            {validationResults.map((vr) => (
              <div
                key={vr.sheetName}
                className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden"
              >
                {/* Validation header */}
                <div className="flex items-center justify-between p-4 bg-surface-50 dark:bg-surface-800/50 border-b border-surface-200 dark:border-surface-700">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                      {vr.sfObject}
                    </h3>
                    <span className="text-xs text-surface-400">({vr.sheetName})</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge label={`${vr.passCount} pass`} variant="success" />
                    {vr.warningCount > 0 && (
                      <StatusBadge label={`${vr.warningCount} warn`} variant="warning" />
                    )}
                    {vr.failCount > 0 && (
                      <StatusBadge label={`${vr.failCount} fail`} variant="danger" />
                    )}
                  </div>
                </div>

                {/* Validation rows */}
                <div className="max-h-[400px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white dark:bg-surface-900">
                      <tr className="border-b border-surface-200 dark:border-surface-700">
                        <th className="px-4 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider w-16">
                          Row
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider w-20">
                          Status
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                          Details
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {vr.rows.map((row) => (
                        <tr
                          key={row.rowIndex}
                          className={`border-b border-surface-100 dark:border-surface-800
                            ${row.status === 'fail' ? 'bg-red-50/50 dark:bg-red-900/10' : ''}
                            ${row.status === 'warning' ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}
                        >
                          <td className="px-4 py-2 text-surface-600 dark:text-surface-400 font-mono text-xs">
                            {row.rowIndex}
                          </td>
                          <td className="px-4 py-2">
                            {row.status === 'pass' && (
                              <CheckCircle className="w-4 h-4 text-green-500" />
                            )}
                            {row.status === 'warning' && (
                              <AlertTriangle className="w-4 h-4 text-amber-500" />
                            )}
                            {row.status === 'fail' && (
                              <XCircle className="w-4 h-4 text-red-500" />
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs">
                            {row.errors.length > 0 && (
                              <ul className="space-y-0.5">
                                {row.errors.map((err, i) => (
                                  <li key={i} className="text-red-600 dark:text-red-400">
                                    {err}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {row.warnings.length > 0 && (
                              <ul className="space-y-0.5">
                                {row.warnings.map((w, i) => (
                                  <li key={i} className="text-amber-600 dark:text-amber-400">
                                    {w}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {row.errors.length === 0 && row.warnings.length === 0 && (
                              <span className="text-green-600 dark:text-green-400">All checks passed</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {/* Loading sequence */}
            {validationResults.length > 0 && (
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-3">
                  Loading Sequence
                </h3>
                <div className="flex items-center gap-2 flex-wrap">
                  {LOAD_ORDER
                    .filter((obj) => validationResults.some((vr) => vr.sfObject === obj))
                    .map((obj, idx, arr) => (
                      <div key={obj} className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-100 dark:bg-surface-700 text-sm text-surface-700 dark:text-surface-300">
                          <span className="w-5 h-5 rounded-full bg-primary-500 text-white text-xs flex items-center justify-center">
                            {idx + 1}
                          </span>
                          {obj}
                        </div>
                        {idx < arr.length - 1 && (
                          <ArrowRight className="w-4 h-4 text-surface-300 dark:text-surface-600" />
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── Step 4: Preview ────────────────────────────────────────── */}
        {currentStep === 'Preview' && (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-green-50/50 dark:bg-green-900/10">
                <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                  To Create
                </p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">
                  {previewSummary.reduce((sum, s) => sum + s.toCreate, 0)}
                </p>
              </div>
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-blue-50/50 dark:bg-blue-900/10">
                <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                  To Update
                </p>
                <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">
                  {previewSummary.reduce((sum, s) => sum + s.toUpdate, 0)}
                </p>
              </div>
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-red-50/50 dark:bg-red-900/10">
                <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                  Skipped (errors)
                </p>
                <p className="text-2xl font-bold text-red-600 dark:text-red-400 mt-1">
                  {previewSummary.reduce((sum, s) => sum + s.skipped, 0)}
                </p>
              </div>
            </div>

            {/* Per-object breakdown */}
            <div className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50">
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                      Object
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                      Create
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                      Update
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                      Skipped
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {previewSummary.map((s) => (
                    <tr
                      key={s.sfObject}
                      className="border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50"
                    >
                      <td className="px-4 py-2.5 font-medium text-surface-800 dark:text-surface-200">
                        {s.sfObject}
                      </td>
                      <td className="px-4 py-2.5 text-right text-green-600 dark:text-green-400">
                        {s.toCreate}
                      </td>
                      <td className="px-4 py-2.5 text-right text-blue-600 dark:text-blue-400">
                        {s.toUpdate}
                      </td>
                      <td className="px-4 py-2.5 text-right text-red-600 dark:text-red-400">
                        {s.skipped}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Per-object data preview */}
            {validationResults.map((vr) => {
              const validRows = vr.rows.filter((r) => r.status !== 'fail');
              if (validRows.length === 0) return null;

              const fields = Object.keys(validRows[0].data);
              const columns: ColumnDef<ValidationRow, unknown>[] = [
                {
                  id: 'rowIndex',
                  header: 'Row',
                  accessorFn: (row) => row.rowIndex,
                  cell: ({ getValue }) => (
                    <span className="font-mono text-xs text-surface-500">{String(getValue())}</span>
                  ),
                },
                ...fields.map((f) => ({
                  id: f,
                  header: f,
                  accessorFn: (row: ValidationRow) => row.data[f],
                  cell: ({ getValue }: { getValue: () => unknown }) => {
                    const v = getValue();
                    return (
                      <span className="truncate max-w-[180px] block text-xs">
                        {v == null ? '' : String(v)}
                      </span>
                    );
                  },
                })),
              ];

              return (
                <DataTable
                  key={vr.sfObject}
                  data={validRows}
                  columns={columns}
                  title={`${vr.sfObject} - ${validRows.length} records`}
                  pageSize={10}
                  exportable={false}
                />
              );
            })}
          </div>
        )}

        {/* ─── Step 5: Push ───────────────────────────────────────────── */}
        {currentStep === 'Push' && !pushSummary && (
          <div className="space-y-6">
            {!pushing && (
              <div className="flex flex-col items-center justify-center py-12 gap-6">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center">
                  <Play className="w-8 h-8 text-white" />
                </div>
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-surface-800 dark:text-surface-200">
                    Ready to Push
                  </h3>
                  <p className="text-sm text-surface-500 dark:text-surface-400 mt-1 max-w-md">
                    This will create and update records in your Salesforce org
                    ({auth.orgType === 'sandbox' ? 'Sandbox' : 'Production'}).
                    Records will be loaded in dependency order.
                  </p>
                </div>
                <button
                  onClick={pushToSalesforce}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-primary-500 text-white font-medium
                             hover:bg-primary-600 transition-colors shadow-sm"
                >
                  <Play className="w-4 h-4" />
                  Start Loading
                </button>
              </div>
            )}

            {pushing && (
              <div className="flex flex-col items-center justify-center py-12 gap-6">
                <LoadingSpinner message={pushProgress.label} />
                <div className="w-full max-w-md">
                  <div className="flex items-center justify-between text-xs text-surface-500 dark:text-surface-400 mb-1.5">
                    <span>{pushProgress.label}</span>
                    <span>
                      {pushProgress.current} / {pushProgress.total}
                    </span>
                  </div>
                  <div className="w-full bg-surface-200 dark:bg-surface-700 rounded-full h-2.5">
                    <div
                      className="bg-primary-500 h-2.5 rounded-full transition-all duration-300"
                      style={{
                        width:
                          pushProgress.total > 0
                            ? `${(pushProgress.current / pushProgress.total) * 100}%`
                            : '0%',
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── Step 6: Results ────────────────────────────────────────── */}
        {currentStep === 'Results' && pushSummary && (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-green-50/50 dark:bg-green-900/10">
                <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                  Created
                </p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">
                  {pushSummary.created}
                </p>
              </div>
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-blue-50/50 dark:bg-blue-900/10">
                <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                  Updated
                </p>
                <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">
                  {pushSummary.updated}
                </p>
              </div>
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-red-50/50 dark:bg-red-900/10">
                <p className="text-xs text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                  Failed
                </p>
                <p className="text-2xl font-bold text-red-600 dark:text-red-400 mt-1">
                  {pushSummary.failed}
                </p>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              {pushSummary.failed > 0 && (
                <button
                  onClick={downloadErrorReport}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-300 dark:border-red-700
                             text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-sm font-medium"
                >
                  <Download className="w-4 h-4" />
                  Download Error Report
                </button>
              )}
              <button
                onClick={resetWizard}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-surface-300 dark:border-surface-600
                           text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors text-sm font-medium"
              >
                <RefreshCw className="w-4 h-4" />
                Load Another File
              </button>
            </div>

            {/* Results table */}
            {(() => {
              const resultColumns: ColumnDef<PushRowResult, unknown>[] = [
                {
                  id: 'rowIndex',
                  header: 'Row',
                  accessorKey: 'rowIndex',
                  cell: ({ getValue }) => (
                    <span className="font-mono text-xs">{String(getValue())}</span>
                  ),
                },
                {
                  id: 'sfObject',
                  header: 'Object',
                  accessorKey: 'sfObject',
                },
                {
                  id: 'operation',
                  header: 'Operation',
                  accessorKey: 'operation',
                  cell: ({ getValue }) => (
                    <StatusBadge
                      label={String(getValue())}
                      variant={getValue() === 'create' ? 'success' : 'info'}
                    />
                  ),
                },
                {
                  id: 'status',
                  header: 'Status',
                  accessorFn: (row) => (row.success ? 'Success' : 'Failed'),
                  cell: ({ row }) =>
                    row.original.success ? (
                      <CheckCircle className="w-4 h-4 text-green-500" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-500" />
                    ),
                },
                {
                  id: 'recordId',
                  header: 'Record ID',
                  accessorKey: 'recordId',
                  cell: ({ getValue, row: _row }) => {
                    const id = getValue() as string | undefined;
                    if (!id) return null;
                    return (
                      <a
                        href={`${auth.instanceUrl}/${id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-mono text-primary-500 hover:text-primary-600 dark:hover:text-primary-400 underline"
                      >
                        {id}
                      </a>
                    );
                  },
                },
                {
                  id: 'error',
                  header: 'Error',
                  accessorKey: 'error',
                  cell: ({ getValue }) => {
                    const err = getValue() as string | undefined;
                    if (!err) return null;
                    return (
                      <span className="text-xs text-red-600 dark:text-red-400 truncate max-w-[300px] block" title={err}>
                        {err}
                      </span>
                    );
                  },
                },
              ];

              return (
                <DataTable
                  data={pushSummary.results}
                  columns={resultColumns}
                  title={`Results - ${pushSummary.results.length} records`}
                  pageSize={25}
                  exportFilename="fsl-load-results"
                />
              );
            })()}
          </div>
        )}
      </div>

      {/* Navigation footer */}
      <div className="flex items-center justify-between pt-3 border-t border-surface-200 dark:border-surface-700">
        <button
          onClick={goBack}
          disabled={currentStepIndex === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                     text-surface-600 dark:text-surface-400
                     hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors
                     disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <div className="text-xs text-surface-400 dark:text-surface-500">
          Step {currentStepIndex + 1} of {STEPS.length}
        </div>

        {currentStep !== 'Results' && (
          <button
            onClick={goNext}
            disabled={!canGoNext()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                       bg-primary-500 text-white hover:bg-primary-600 transition-colors
                       disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {currentStep === 'Preview' ? 'Push' : 'Next'}
            <ArrowRight className="w-4 h-4" />
          </button>
        )}

        {currentStep === 'Results' && (
          <button
            onClick={resetWizard}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                       bg-primary-500 text-white hover:bg-primary-600 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Start Over
          </button>
        )}
      </div>
    </div>
  );
}
