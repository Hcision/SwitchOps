import { useState, useCallback, useRef } from 'react';
import {
  Package,
  FileSpreadsheet,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  Download,
  Play,
  Upload,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { describe, composite } from '@/services/salesforce';
import { saveAs } from 'file-saver';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported CPQ Salesforce objects in dependency order. */
type CpqObjectName =
  | 'Product2'
  | 'PricebookEntry'
  | 'SBQQ__ProductFeature__c'
  | 'SBQQ__ProductOption__c'
  | 'SBQQ__PriceRule__c'
  | 'SBQQ__ConfigurationRule__c'
  | 'SBQQ__DiscountSchedule__c';

interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, unknown>[];
}

interface ColumnMapping {
  sourceColumn: string;
  targetField: string;
  dataType: string;
  required: boolean;
  isLookup: boolean;
  lookupObject?: string;
}

interface SheetMapping {
  sheetName: string;
  targetObject: CpqObjectName | '';
  columnMappings: ColumnMapping[];
}

interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  referenceTo: string[];
  relationshipName: string | null;
}

interface ValidationIssue {
  sheetName: string;
  rowIndex: number;
  column: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

interface RowResult {
  sheetName: string;
  rowIndex: number;
  status: 'success' | 'error';
  recordId?: string;
  errorMessage?: string;
  data: Record<string, unknown>;
}

type WizardStep = 'upload' | 'mapping' | 'validation' | 'preview' | 'push' | 'results';

const WIZARD_STEPS: { key: WizardStep; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'mapping', label: 'Mapping' },
  { key: 'validation', label: 'Validation' },
  { key: 'preview', label: 'Preview' },
  { key: 'push', label: 'Push' },
  { key: 'results', label: 'Results' },
];

/** CPQ objects listed in correct dependency / loading order. */
const CPQ_OBJECTS: { value: CpqObjectName; label: string; order: number }[] = [
  { value: 'Product2', label: 'Product2', order: 1 },
  { value: 'PricebookEntry', label: 'PricebookEntry', order: 2 },
  { value: 'SBQQ__ProductFeature__c', label: 'Product Feature', order: 3 },
  { value: 'SBQQ__ProductOption__c', label: 'Product Option', order: 4 },
  { value: 'SBQQ__PriceRule__c', label: 'Price Rule', order: 5 },
  { value: 'SBQQ__ConfigurationRule__c', label: 'Configuration Rule', order: 6 },
  { value: 'SBQQ__DiscountSchedule__c', label: 'Discount Schedule', order: 7 },
];

const FIELD_TYPE_LABELS: Record<string, string> = {
  string: 'Text',
  boolean: 'Checkbox',
  int: 'Integer',
  double: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  date: 'Date',
  datetime: 'Date/Time',
  reference: 'Lookup',
  picklist: 'Picklist',
  multipicklist: 'Multi-Picklist',
  textarea: 'Text Area',
  id: 'Id',
  email: 'Email',
  url: 'URL',
  phone: 'Phone',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cpqOrder(objName: CpqObjectName | ''): number {
  return CPQ_OBJECTS.find((o) => o.value === objName)?.order ?? 99;
}

function autoDetectField(
  header: string,
  fields: FieldDescribe[],
): FieldDescribe | undefined {
  const lower = header.toLowerCase().replace(/[\s_]+/g, '');
  // exact match on API name
  const exact = fields.find((f) => f.name.toLowerCase() === header.toLowerCase());
  if (exact) return exact;
  // exact match on label
  const labelMatch = fields.find(
    (f) => f.label.toLowerCase().replace(/[\s_]+/g, '') === lower,
  );
  if (labelMatch) return labelMatch;
  // partial match
  return fields.find(
    (f) =>
      f.name.toLowerCase().replace(/[\s_]+/g, '').includes(lower) ||
      lower.includes(f.name.toLowerCase().replace(/[\s_]+/g, '')),
  );
}

function coerceValue(
  raw: unknown,
  fieldType: string,
): { value: unknown; error?: string } {
  if (raw === null || raw === undefined || raw === '') {
    return { value: null };
  }
  const str = String(raw).trim();
  switch (fieldType) {
    case 'boolean':
      if (/^(true|yes|1)$/i.test(str)) return { value: true };
      if (/^(false|no|0)$/i.test(str)) return { value: false };
      return { value: null, error: `Invalid boolean: "${str}"` };
    case 'int': {
      const n = parseInt(str, 10);
      return isNaN(n)
        ? { value: null, error: `Invalid integer: "${str}"` }
        : { value: n };
    }
    case 'double':
    case 'currency':
    case 'percent': {
      const n = parseFloat(str);
      return isNaN(n)
        ? { value: null, error: `Invalid number: "${str}"` }
        : { value: n };
    }
    case 'date': {
      const d = new Date(str);
      if (isNaN(d.getTime()))
        return { value: null, error: `Invalid date: "${str}"` };
      return { value: d.toISOString().split('T')[0] };
    }
    case 'datetime': {
      const d = new Date(str);
      if (isNaN(d.getTime()))
        return { value: null, error: `Invalid datetime: "${str}"` };
      return { value: d.toISOString() };
    }
    default:
      return { value: str };
  }
}

// ---------------------------------------------------------------------------
// Preview Table Columns
// ---------------------------------------------------------------------------

function buildPreviewColumns(headers: string[]): ColumnDef<Record<string, unknown>, unknown>[] {
  return headers.map((h) => ({
    accessorKey: h,
    header: h,
    cell: ({ getValue }: { getValue: () => unknown }) => {
      const v = getValue();
      return (
        <span className="text-xs max-w-[200px] block truncate">
          {v == null ? '\u2014' : String(v)}
        </span>
      );
    },
  }));
}

const resultColumns: ColumnDef<RowResult, unknown>[] = [
  {
    accessorKey: 'sheetName',
    header: 'Sheet',
    cell: ({ getValue }) => (
      <span className="text-xs font-medium">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: 'rowIndex',
    header: 'Row',
    cell: ({ getValue }) => (
      <span className="text-xs font-mono">{getValue<number>() + 1}</span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ getValue }) => {
      const v = getValue<string>();
      return (
        <StatusBadge
          label={v}
          variant={v === 'success' ? 'success' : 'danger'}
        />
      );
    },
  },
  {
    accessorKey: 'recordId',
    header: 'Record Id',
    cell: ({ getValue }) => {
      const v = getValue<string>();
      return v ? (
        <span className="text-xs font-mono text-primary-600 dark:text-primary-400">{v}</span>
      ) : (
        <span className="text-xs text-surface-400">{'\u2014'}</span>
      );
    },
  },
  {
    accessorKey: 'errorMessage',
    header: 'Error',
    cell: ({ getValue }) => {
      const v = getValue<string>();
      return v ? (
        <span className="text-xs text-red-600 dark:text-red-400 max-w-[300px] block truncate" title={v}>
          {v}
        </span>
      ) : (
        <span className="text-xs text-surface-400">{'\u2014'}</span>
      );
    },
  },
];

const validationColumns: ColumnDef<ValidationIssue, unknown>[] = [
  {
    accessorKey: 'sheetName',
    header: 'Sheet',
    cell: ({ getValue }) => (
      <span className="text-xs font-medium">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: 'rowIndex',
    header: 'Row',
    cell: ({ getValue }) => (
      <span className="text-xs font-mono">{getValue<number>() + 1}</span>
    ),
  },
  {
    accessorKey: 'column',
    header: 'Column',
    cell: ({ getValue }) => (
      <span className="text-xs">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: 'field',
    header: 'Field',
    cell: ({ getValue }) => (
      <span className="text-xs font-mono">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: 'severity',
    header: 'Severity',
    cell: ({ getValue }) => {
      const v = getValue<string>();
      return <StatusBadge label={v} variant={v === 'error' ? 'danger' : 'warning'} />;
    },
  },
  {
    accessorKey: 'message',
    header: 'Message',
    cell: ({ getValue }) => (
      <span className="text-xs max-w-[350px] block truncate" title={getValue<string>()}>
        {getValue<string>()}
      </span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function CpqLoader() {
  // ── Store ──────────────────────────────────────────────────────────────
  // ── Wizard state ───────────────────────────────────────────────────────
  const [step, setStep] = useState<WizardStep>('upload');
  const [error, setError] = useState<string | null>(null);

  // ── Upload state ───────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [previewSheet, setPreviewSheet] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ── Mapping state ──────────────────────────────────────────────────────
  const [sheetMappings, setSheetMappings] = useState<SheetMapping[]>([]);
  const [objectFieldsCache, setObjectFieldsCache] = useState<
    Record<string, FieldDescribe[]>
  >({});
  const [loadingFields, setLoadingFields] = useState(false);

  // ── Validation state ───────────────────────────────────────────────────
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([]);
  const [isValidating, setIsValidating] = useState(false);

  // ── Push state ─────────────────────────────────────────────────────────
  const [isPushing, setIsPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState({ done: 0, total: 0 });
  const [pushCurrentObject, setPushCurrentObject] = useState('');

  // ── Results state ──────────────────────────────────────────────────────
  const [results, setResults] = useState<RowResult[]>([]);

  // =====================================================================
  // Step helpers
  // =====================================================================

  const stepIndex = WIZARD_STEPS.findIndex((s) => s.key === step);

  const canGoNext = useCallback((): boolean => {
    switch (step) {
      case 'upload':
        return sheets.length > 0;
      case 'mapping':
        return sheetMappings.every(
          (m) => m.targetObject !== '' && m.columnMappings.some((c) => c.targetField !== ''),
        );
      case 'validation':
        return validationIssues.filter((i) => i.severity === 'error').length === 0;
      case 'preview':
        return true;
      default:
        return false;
    }
  }, [step, sheets, sheetMappings, validationIssues]);

  const goNext = useCallback(() => {
    const idx = stepIndex;
    if (idx < WIZARD_STEPS.length - 1) setStep(WIZARD_STEPS[idx + 1].key);
  }, [stepIndex]);

  const goBack = useCallback(() => {
    const idx = stepIndex;
    if (idx > 0) setStep(WIZARD_STEPS[idx - 1].key);
  }, [stepIndex]);

  // =====================================================================
  // Upload Step
  // =====================================================================

  const parseFile = useCallback((file: File) => {
    setError(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const parsed: ParsedSheet[] = workbook.SheetNames.map((name) => {
          const worksheet = workbook.Sheets[name];
          const json: Record<string, unknown>[] = XLSX.utils.sheet_to_json(worksheet, {
            defval: '',
          });
          const headers =
            json.length > 0 ? Object.keys(json[0]) : [];
          return { name, headers, rows: json };
        }).filter((s) => s.rows.length > 0);

        if (parsed.length === 0) {
          setError('No data found in the uploaded file. Please ensure your file contains at least one sheet with data.');
          return;
        }

        setSheets(parsed);
        setPreviewSheet(parsed[0].name);

        // Initialise sheet mappings
        const mappings: SheetMapping[] = parsed.map((s) => ({
          sheetName: s.name,
          targetObject: '' as CpqObjectName | '',
          columnMappings: s.headers.map((h) => ({
            sourceColumn: h,
            targetField: '',
            dataType: 'string',
            required: false,
            isLookup: false,
          })),
        }));
        setSheetMappings(mappings);
      } catch {
        setError('Failed to parse the file. Please ensure it is a valid Excel (.xlsx/.xls) or CSV file.');
      }
    };
    reader.onerror = () => setError('Failed to read the file.');
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) parseFile(file);
    },
    [parseFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) parseFile(file);
    },
    [parseFile],
  );

  // =====================================================================
  // Mapping Step
  // =====================================================================

  const fetchObjectFields = useCallback(
    async (objectName: CpqObjectName) => {
      if (objectFieldsCache[objectName]) return objectFieldsCache[objectName];
      setLoadingFields(true);
      try {
        const desc = await describe(objectName);
        const fields: FieldDescribe[] = desc.fields
          .filter((f) => f.createable || f.updateable)
          .map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            nillable: f.nillable,
            createable: f.createable,
            updateable: f.updateable,
            referenceTo: f.referenceTo,
            relationshipName: f.relationshipName,
          }));
        setObjectFieldsCache((prev) => ({ ...prev, [objectName]: fields }));
        return fields;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to describe ${objectName}: ${msg}`);
        return [];
      } finally {
        setLoadingFields(false);
      }
    },
    [objectFieldsCache],
  );

  const handleObjectChange = useCallback(
    async (sheetName: string, objectName: CpqObjectName | '') => {
      setSheetMappings((prev) =>
        prev.map((m) => {
          if (m.sheetName !== sheetName) return m;
          return { ...m, targetObject: objectName, columnMappings: m.columnMappings.map((c) => ({ ...c, targetField: '', dataType: 'string', required: false, isLookup: false, lookupObject: undefined })) };
        }),
      );

      if (objectName === '') return;

      const fields = await fetchObjectFields(objectName);
      if (fields.length === 0) return;

      const sheet = sheets.find((s) => s.name === sheetName);
      if (!sheet) return;

      // Auto-detect column mappings
      setSheetMappings((prev) =>
        prev.map((m) => {
          if (m.sheetName !== sheetName) return m;
          const newMappings = m.columnMappings.map((cm) => {
            const detected = autoDetectField(cm.sourceColumn, fields);
            if (!detected) return cm;
            return {
              ...cm,
              targetField: detected.name,
              dataType: detected.type,
              required: !detected.nillable && detected.createable,
              isLookup: detected.type === 'reference',
              lookupObject: detected.referenceTo?.[0],
            };
          });
          return { ...m, columnMappings: newMappings };
        }),
      );
    },
    [fetchObjectFields, sheets],
  );

  const handleFieldChange = useCallback(
    (sheetName: string, sourceColumn: string, fieldName: string) => {
      setSheetMappings((prev) =>
        prev.map((m) => {
          if (m.sheetName !== sheetName) return m;
          const fields = objectFieldsCache[m.targetObject] ?? [];
          const field = fields.find((f) => f.name === fieldName);
          return {
            ...m,
            columnMappings: m.columnMappings.map((cm) => {
              if (cm.sourceColumn !== sourceColumn) return cm;
              if (!field) return { ...cm, targetField: '', dataType: 'string', required: false, isLookup: false, lookupObject: undefined };
              return {
                ...cm,
                targetField: field.name,
                dataType: field.type,
                required: !field.nillable && field.createable,
                isLookup: field.type === 'reference',
                lookupObject: field.referenceTo?.[0],
              };
            }),
          };
        }),
      );
    },
    [objectFieldsCache],
  );

  // =====================================================================
  // Validation Step
  // =====================================================================

  const runValidation = useCallback(async () => {
    setIsValidating(true);
    setError(null);
    const issues: ValidationIssue[] = [];

    // 1. Loading sequence validation
    const assignedObjects = sheetMappings
      .filter((m) => m.targetObject !== '')
      .map((m) => m.targetObject as CpqObjectName);

    const objectOrderMap = new Map(CPQ_OBJECTS.map((o) => [o.value, o.order]));
    const sortedByOrder = [...sheetMappings]
      .filter((m) => m.targetObject !== '')
      .sort((a, b) => cpqOrder(a.targetObject) - cpqOrder(b.targetObject));

    // Check that lookup references point to objects that are also being loaded (or already exist)
    for (const mapping of sortedByOrder) {
      const sheet = sheets.find((s) => s.name === mapping.sheetName);
      if (!sheet) continue;

      const lookupMappings = mapping.columnMappings.filter(
        (cm) => cm.isLookup && cm.targetField !== '' && cm.lookupObject,
      );

      for (const lm of lookupMappings) {
        const lookupObjOrder = objectOrderMap.get(lm.lookupObject as CpqObjectName);
        const currentObjOrder = objectOrderMap.get(mapping.targetObject as CpqObjectName);

        if (
          lookupObjOrder !== undefined &&
          currentObjOrder !== undefined &&
          lookupObjOrder >= currentObjOrder &&
          assignedObjects.includes(lm.lookupObject as CpqObjectName)
        ) {
          issues.push({
            sheetName: mapping.sheetName,
            rowIndex: -1,
            column: lm.sourceColumn,
            field: lm.targetField,
            severity: 'warning',
            message: `Lookup to ${lm.lookupObject} may fail: it loads at the same time or after ${mapping.targetObject}. Ensure referenced records exist.`,
          });
        }
      }

      // 2. Row-level validation
      for (let rowIdx = 0; rowIdx < sheet.rows.length; rowIdx++) {
        const row = sheet.rows[rowIdx];

        for (const cm of mapping.columnMappings) {
          if (cm.targetField === '') continue;

          const rawValue = row[cm.sourceColumn];

          // Required field check
          if (cm.required && (rawValue === null || rawValue === undefined || rawValue === '')) {
            issues.push({
              sheetName: mapping.sheetName,
              rowIndex: rowIdx,
              column: cm.sourceColumn,
              field: cm.targetField,
              severity: 'error',
              message: `Required field "${cm.targetField}" is empty.`,
            });
            continue;
          }

          // Data type validation
          if (rawValue !== null && rawValue !== undefined && rawValue !== '') {
            const { error: coerceErr } = coerceValue(rawValue, cm.dataType);
            if (coerceErr) {
              issues.push({
                sheetName: mapping.sheetName,
                rowIndex: rowIdx,
                column: cm.sourceColumn,
                field: cm.targetField,
                severity: 'error',
                message: coerceErr,
              });
            }
          }
        }
      }
    }

    // 3. Lookup reference validation for Product Options -> Products
    const productMapping = sheetMappings.find((m) => m.targetObject === 'Product2');
    const optionMapping = sheetMappings.find((m) => m.targetObject === 'SBQQ__ProductOption__c');

    if (productMapping && optionMapping) {
      const productSheet = sheets.find((s) => s.name === productMapping.sheetName);
      const optionSheet = sheets.find((s) => s.name === optionMapping.sheetName);

      if (productSheet && optionSheet) {
        // Find the product Name or ProductCode column in the product sheet
        const productNameCol = productMapping.columnMappings.find(
          (cm) => cm.targetField === 'Name',
        );
        const productNames = productNameCol
          ? new Set(productSheet.rows.map((r) => String(r[productNameCol.sourceColumn] ?? '')))
          : new Set<string>();

        // Find lookup columns in options that reference Product2
        const optionLookupCols = optionMapping.columnMappings.filter(
          (cm) => cm.isLookup && cm.lookupObject === 'Product2',
        );

        for (const lc of optionLookupCols) {
          for (let rowIdx = 0; rowIdx < optionSheet.rows.length; rowIdx++) {
            const val = String(optionSheet.rows[rowIdx][lc.sourceColumn] ?? '');
            if (val && !productNames.has(val) && !val.match(/^[a-zA-Z0-9]{15,18}$/)) {
              issues.push({
                sheetName: optionMapping.sheetName,
                rowIndex: rowIdx,
                column: lc.sourceColumn,
                field: lc.targetField,
                severity: 'warning',
                message: `Product reference "${val}" not found in uploaded Products. It must already exist in Salesforce.`,
              });
            }
          }
        }
      }
    }

    setValidationIssues(issues);
    setIsValidating(false);
  }, [sheetMappings, sheets]);

  // =====================================================================
  // Push to Salesforce
  // =====================================================================

  const pushToSalesforce = useCallback(async () => {
    setIsPushing(true);
    setError(null);
    const allResults: RowResult[] = [];

    // Sort mappings by dependency order
    const sortedMappings = [...sheetMappings]
      .filter((m) => m.targetObject !== '')
      .sort((a, b) => cpqOrder(a.targetObject) - cpqOrder(b.targetObject));

    const totalRows = sortedMappings.reduce((sum, m) => {
      const sheet = sheets.find((s) => s.name === m.sheetName);
      return sum + (sheet?.rows.length ?? 0);
    }, 0);

    setPushProgress({ done: 0, total: totalRows });

    // Map to track created record IDs by object type + name for lookup resolution
    const createdRecords = new Map<string, string>();

    for (const mapping of sortedMappings) {
      const sheet = sheets.find((s) => s.name === mapping.sheetName);
      if (!sheet) continue;

      const objectName = mapping.targetObject as CpqObjectName;
      setPushCurrentObject(objectName);
      const activeMappings = mapping.columnMappings.filter(
        (cm) => cm.targetField !== '',
      );

      // Process in batches of 25 (Composite API limit)
      for (let batchStart = 0; batchStart < sheet.rows.length; batchStart += 25) {
        const batchRows = sheet.rows.slice(batchStart, batchStart + 25);
        const compositeRequests = batchRows.map((row, batchIdx) => {
          const body: Record<string, unknown> = {};

          for (const cm of activeMappings) {
            const raw = row[cm.sourceColumn];
            if (raw === null || raw === undefined || raw === '') continue;

            const { value } = coerceValue(raw, cm.dataType);
            if (value === null) continue;

            // If lookup field, try to resolve from previously created records
            if (cm.isLookup && cm.lookupObject) {
              const strVal = String(value);
              // If it looks like a Salesforce Id, use directly
              if (/^[a-zA-Z0-9]{15,18}$/.test(strVal)) {
                body[cm.targetField] = strVal;
              } else {
                // Try to resolve from created records map
                const resolvedId = createdRecords.get(`${cm.lookupObject}:${strVal}`);
                if (resolvedId) {
                  body[cm.targetField] = resolvedId;
                } else {
                  body[cm.targetField] = strVal;
                }
              }
            } else {
              body[cm.targetField] = value;
            }
          }

          const refId = `ref_${mapping.sheetName.replace(/\W/g, '_')}_${batchStart + batchIdx}`;
          return {
            method: 'POST' as const,
            url: `/services/data/v62.0/sobjects/${objectName}`,
            referenceId: refId,
            body,
          };
        });

        try {
          const response = await composite(compositeRequests, false);

          for (let i = 0; i < response.compositeResponse.length; i++) {
            const res = response.compositeResponse[i];
            const globalRowIdx = batchStart + i;
            const row = sheet.rows[globalRowIdx];

            if (res.httpStatusCode >= 200 && res.httpStatusCode < 300) {
              const createdBody = res.body as { id?: string };
              const recordId = createdBody?.id ?? '';

              // Store created record for future lookup resolution
              const nameMapping = activeMappings.find((cm) => cm.targetField === 'Name');
              if (nameMapping && row[nameMapping.sourceColumn]) {
                createdRecords.set(
                  `${objectName}:${String(row[nameMapping.sourceColumn])}`,
                  recordId,
                );
              }

              allResults.push({
                sheetName: mapping.sheetName,
                rowIndex: globalRowIdx,
                status: 'success',
                recordId,
                data: row,
              });
            } else {
              const errBody = res.body as { message?: string } | Array<{ message?: string }>;
              const msg = Array.isArray(errBody)
                ? errBody.map((e) => e.message).join('; ')
                : (errBody as { message?: string })?.message ?? 'Unknown error';

              allResults.push({
                sheetName: mapping.sheetName,
                rowIndex: globalRowIdx,
                status: 'error',
                errorMessage: msg,
                data: row,
              });
            }
          }
        } catch (err: unknown) {
          // If entire composite call fails, mark all rows in batch as failed
          for (let i = 0; i < batchRows.length; i++) {
            const globalRowIdx = batchStart + i;
            allResults.push({
              sheetName: mapping.sheetName,
              rowIndex: globalRowIdx,
              status: 'error',
              errorMessage: err instanceof Error ? err.message : String(err),
              data: sheet.rows[globalRowIdx],
            });
          }
        }

        setPushProgress((prev) => ({
          ...prev,
          done: prev.done + batchRows.length,
        }));
      }
    }

    setResults(allResults);
    setIsPushing(false);
    setStep('results');
  }, [sheetMappings, sheets]);

  // =====================================================================
  // Results helpers
  // =====================================================================

  const downloadErrorCsv = useCallback(() => {
    const errors = results.filter((r) => r.status === 'error');
    if (errors.length === 0) return;

    const allKeys = new Set<string>();
    errors.forEach((e) => Object.keys(e.data).forEach((k) => allKeys.add(k)));
    const dataHeaders = Array.from(allKeys);

    const csvHeaders = ['Sheet', 'Row', 'Error', ...dataHeaders];
    const csvRows = errors.map((e) => {
      const vals = [
        e.sheetName,
        String(e.rowIndex + 1),
        `"${(e.errorMessage ?? '').replace(/"/g, '""')}"`,
        ...dataHeaders.map((h) => {
          const v = e.data[h];
          const s = v == null ? '' : String(v);
          return s.includes(',') || s.includes('"')
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        }),
      ];
      return vals.join(',');
    });

    const csv = [csvHeaders.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, 'cpq-loader-errors.csv');
  }, [results]);

  const reuploadFailed = useCallback(() => {
    const errors = results.filter((r) => r.status === 'error');
    if (errors.length === 0) return;

    // Group failed rows by sheet
    const grouped = new Map<string, Record<string, unknown>[]>();
    errors.forEach((e) => {
      const arr = grouped.get(e.sheetName) ?? [];
      arr.push(e.data);
      grouped.set(e.sheetName, arr);
    });

    const newSheets: ParsedSheet[] = [];
    grouped.forEach((rows, sheetName) => {
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      newSheets.push({ name: sheetName, headers, rows });
    });

    setSheets(newSheets);
    setPreviewSheet(newSheets[0]?.name ?? null);

    // Keep only relevant mappings
    setSheetMappings((prev) =>
      prev.filter((m) => grouped.has(m.sheetName)),
    );

    setResults([]);
    setValidationIssues([]);
    setStep('mapping');
  }, [results]);

  // =====================================================================
  // Render helpers
  // =====================================================================

  const renderStepIndicator = () => (
    <div className="flex items-center gap-1 mb-6 px-1">
      {WIZARD_STEPS.map((s, i) => {
        const isActive = s.key === step;
        const isComplete = i < stepIndex;
        return (
          <div key={s.key} className="flex items-center">
            {i > 0 && (
              <div
                className={`w-8 h-px mx-1 ${
                  isComplete
                    ? 'bg-primary-500'
                    : 'bg-surface-200 dark:bg-surface-700'
                }`}
              />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold
                  ${
                    isActive
                      ? 'bg-primary-500 text-white'
                      : isComplete
                        ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-400'
                        : 'bg-surface-100 text-surface-400 dark:bg-surface-800 dark:text-surface-500'
                  }`}
              >
                {isComplete ? (
                  <CheckCircle className="w-3.5 h-3.5" />
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`text-xs font-medium hidden sm:inline ${
                  isActive
                    ? 'text-primary-600 dark:text-primary-400'
                    : isComplete
                      ? 'text-surface-600 dark:text-surface-400'
                      : 'text-surface-400 dark:text-surface-500'
                }`}
              >
                {s.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );

  // ── Upload Step ────────────────────────────────────────────────────────

  const renderUploadStep = () => (
    <div className="space-y-6">
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors
          ${
            isDragging
              ? 'border-primary-400 bg-primary-50 dark:bg-primary-900/20'
              : 'border-surface-300 dark:border-surface-600 hover:border-primary-300 dark:hover:border-primary-700 bg-surface-50 dark:bg-surface-800/50'
          }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFileInput}
          className="hidden"
        />
        <Upload className="w-10 h-10 mx-auto mb-3 text-surface-400 dark:text-surface-500" />
        <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
          Drag & drop your Excel or CSV file here
        </p>
        <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
          or click to browse. Supports .xlsx, .xls, and .csv
        </p>
      </div>

      {/* File info */}
      {fileName && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
          <FileSpreadsheet className="w-5 h-5 text-green-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-surface-800 dark:text-surface-200 truncate">
              {fileName}
            </p>
            <p className="text-xs text-surface-400">
              {sheets.length} sheet{sheets.length !== 1 ? 's' : ''} detected
              {' \u2022 '}
              {sheets.reduce((sum, s) => sum + s.rows.length, 0)} total rows
            </p>
          </div>
        </div>
      )}

      {/* Sheet tabs & preview */}
      {sheets.length > 0 && (
        <div>
          <div className="flex gap-1 border-b border-surface-200 dark:border-surface-700 mb-3">
            {sheets.map((s) => (
              <button
                key={s.name}
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewSheet(s.name);
                }}
                className={`px-3 py-2 text-xs font-medium rounded-t-lg transition-colors
                  ${
                    previewSheet === s.name
                      ? 'bg-white dark:bg-surface-900 text-primary-600 dark:text-primary-400 border border-b-0 border-surface-200 dark:border-surface-700'
                      : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
                  }`}
              >
                {s.name} ({s.rows.length})
              </button>
            ))}
          </div>

          {previewSheet && (() => {
            const sheet = sheets.find((s) => s.name === previewSheet);
            if (!sheet) return null;
            return (
              <DataTable
                data={sheet.rows.slice(0, 50)}
                columns={buildPreviewColumns(sheet.headers)}
                title={`${sheet.name} Preview (first 50 rows)`}
                searchable={false}
                exportable={false}
                pageSize={10}
              />
            );
          })()}
        </div>
      )}
    </div>
  );

  // ── Mapping Step ───────────────────────────────────────────────────────

  const renderMappingStep = () => (
    <div className="space-y-6">
      {loadingFields && <LoadingSpinner message="Loading field metadata from Salesforce..." />}

      {sheetMappings.map((mapping) => {
        const fields = objectFieldsCache[mapping.targetObject] ?? [];
        return (
          <div
            key={mapping.sheetName}
            className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden"
          >
            {/* Sheet header */}
            <div className="flex items-center justify-between gap-4 p-4 bg-surface-50 dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-surface-500" />
                <span className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                  {mapping.sheetName}
                </span>
                <span className="text-xs text-surface-400">
                  ({sheets.find((s) => s.name === mapping.sheetName)?.rows.length ?? 0} rows)
                </span>
              </div>

              {/* Object selector */}
              <select
                value={mapping.targetObject}
                onChange={(e) =>
                  handleObjectChange(mapping.sheetName, e.target.value as CpqObjectName | '')
                }
                className="px-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-900 text-surface-800 dark:text-surface-200
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                <option value="">-- Select CPQ Object --</option>
                {CPQ_OBJECTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Column mappings */}
            {mapping.targetObject !== '' && (
              <div className="divide-y divide-surface-100 dark:divide-surface-800">
                {mapping.columnMappings.map((cm) => (
                  <div
                    key={cm.sourceColumn}
                    className="flex items-center gap-4 px-4 py-2.5"
                  >
                    {/* Source column */}
                    <div className="w-1/4 min-w-0">
                      <span className="text-xs font-mono text-surface-700 dark:text-surface-300 truncate block">
                        {cm.sourceColumn}
                      </span>
                    </div>

                    <ArrowRight className="w-4 h-4 text-surface-300 dark:text-surface-600 shrink-0" />

                    {/* Target field selector */}
                    <div className="w-1/3 min-w-0">
                      <select
                        value={cm.targetField}
                        onChange={(e) =>
                          handleFieldChange(
                            mapping.sheetName,
                            cm.sourceColumn,
                            e.target.value,
                          )
                        }
                        className="w-full px-2 py-1.5 text-xs rounded-lg border border-surface-200 dark:border-surface-600
                                   bg-white dark:bg-surface-900 text-surface-800 dark:text-surface-200
                                   focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                      >
                        <option value="">-- Skip --</option>
                        {fields.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.label} ({f.name})
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Data type badge */}
                    <div className="w-24 shrink-0">
                      {cm.targetField !== '' && (
                        <StatusBadge
                          label={FIELD_TYPE_LABELS[cm.dataType] ?? cm.dataType}
                          variant={cm.isLookup ? 'info' : 'neutral'}
                        />
                      )}
                    </div>

                    {/* Required indicator */}
                    <div className="w-16 shrink-0 text-right">
                      {cm.required && (
                        <span className="text-xs text-red-500 font-medium">Required</span>
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
  );

  // ── Validation Step ────────────────────────────────────────────────────

  const renderValidationStep = () => {
    const errors = validationIssues.filter((i) => i.severity === 'error');
    const warnings = validationIssues.filter((i) => i.severity === 'warning');

    return (
      <div className="space-y-6">
        {/* Run validation button */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
              Data Validation
            </h3>
            <p className="text-xs text-surface-400 mt-0.5">
              Validate all rows against field types, required fields, and lookup references.
            </p>
          </div>
          <button
            onClick={runValidation}
            disabled={isValidating}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                       bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50
                       transition-colors"
          >
            {isValidating ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isValidating ? 'Validating...' : 'Run Validation'}
          </button>
        </div>

        {isValidating && <LoadingSpinner message="Validating data..." />}

        {/* Summary */}
        {!isValidating && validationIssues.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-center gap-3 p-4 rounded-xl bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
              <AlertTriangle className="w-5 h-5 text-surface-400" />
              <div>
                <p className="text-lg font-bold text-surface-800 dark:text-surface-200">
                  {validationIssues.length}
                </p>
                <p className="text-xs text-surface-400">Total Issues</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <XCircle className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-lg font-bold text-red-700 dark:text-red-400">
                  {errors.length}
                </p>
                <p className="text-xs text-red-500">Errors (blocking)</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              <div>
                <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                  {warnings.length}
                </p>
                <p className="text-xs text-amber-500">Warnings</p>
              </div>
            </div>
          </div>
        )}

        {!isValidating && validationIssues.length === 0 && sheets.length > 0 && (
          <div className="flex items-center gap-3 p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <CheckCircle className="w-5 h-5 text-green-500" />
            <div>
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                All rows passed validation
              </p>
              <p className="text-xs text-green-500 mt-0.5">
                No errors or warnings found. You can proceed to the preview step.
              </p>
            </div>
          </div>
        )}

        {/* Issues table */}
        {!isValidating && validationIssues.length > 0 && (
          <DataTable
            data={validationIssues}
            columns={validationColumns}
            title="Validation Issues"
            exportFilename="cpq-validation-issues"
            pageSize={20}
          />
        )}
      </div>
    );
  };

  // ── Preview Step ───────────────────────────────────────────────────────

  const renderPreviewStep = () => {
    const sortedMappings = [...sheetMappings]
      .filter((m) => m.targetObject !== '')
      .sort((a, b) => cpqOrder(a.targetObject) - cpqOrder(b.targetObject));

    const totalRows = sortedMappings.reduce((sum, m) => {
      const sheet = sheets.find((s) => s.name === m.sheetName);
      return sum + (sheet?.rows.length ?? 0);
    }, 0);

    return (
      <div className="space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            <Package className="w-5 h-5 text-primary-500" />
            <div>
              <p className="text-lg font-bold text-surface-800 dark:text-surface-200">
                {sortedMappings.length}
              </p>
              <p className="text-xs text-surface-400">Objects to load</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-xl bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            <FileSpreadsheet className="w-5 h-5 text-green-500" />
            <div>
              <p className="text-lg font-bold text-surface-800 dark:text-surface-200">
                {totalRows}
              </p>
              <p className="text-xs text-surface-400">Total records</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-xl bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            <CheckCircle className="w-5 h-5 text-green-500" />
            <div>
              <p className="text-lg font-bold text-surface-800 dark:text-surface-200">
                {validationIssues.filter((i) => i.severity === 'warning').length}
              </p>
              <p className="text-xs text-surface-400">Warnings</p>
            </div>
          </div>
        </div>

        {/* Dependency tree / load order */}
        <div className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden">
          <div className="p-4 bg-surface-50 dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700">
            <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
              Loading Order (Dependency Tree)
            </h3>
            <p className="text-xs text-surface-400 mt-0.5">
              Records will be created in this order to respect lookup dependencies.
            </p>
          </div>
          <div className="p-4 space-y-3">
            {sortedMappings.map((m, idx) => {
              const sheet = sheets.find((s) => s.name === m.sheetName);
              const rowCount = sheet?.rows.length ?? 0;
              const mappedFields = m.columnMappings.filter(
                (cm) => cm.targetField !== '',
              ).length;
              const lookupFields = m.columnMappings.filter(
                (cm) => cm.isLookup && cm.targetField !== '',
              );

              return (
                <div key={m.sheetName} className="flex items-start gap-3">
                  {/* Order number */}
                  <div className="w-7 h-7 rounded-full bg-primary-100 dark:bg-primary-900/40 flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-primary-700 dark:text-primary-400">
                      {idx + 1}
                    </span>
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                        {CPQ_OBJECTS.find((o) => o.value === m.targetObject)?.label ?? m.targetObject}
                      </span>
                      <StatusBadge label={`${rowCount} rows`} variant="info" />
                      <StatusBadge label={`${mappedFields} fields`} variant="neutral" />
                    </div>
                    <p className="text-xs text-surface-400 mt-0.5">
                      Sheet: {m.sheetName}
                    </p>
                    {lookupFields.length > 0 && (
                      <p className="text-xs text-amber-500 mt-0.5">
                        Lookups: {lookupFields.map((lf) => `${lf.targetField} -> ${lf.lookupObject}`).join(', ')}
                      </p>
                    )}
                  </div>

                  {/* Arrow to next */}
                  {idx < sortedMappings.length - 1 && (
                    <ArrowRight className="w-4 h-4 text-surface-300 dark:text-surface-600 shrink-0 mt-1.5" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ── Push Step ──────────────────────────────────────────────────────────

  const renderPushStep = () => {
    const progressPct =
      pushProgress.total > 0
        ? Math.round((pushProgress.done / pushProgress.total) * 100)
        : 0;

    return (
      <div className="space-y-6">
        {!isPushing && results.length === 0 && (
          <div className="text-center py-12">
            <Package className="w-12 h-12 mx-auto mb-4 text-surface-300 dark:text-surface-600" />
            <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-2">
              Ready to Push to Salesforce
            </h3>
            <p className="text-xs text-surface-400 mb-6 max-w-md mx-auto">
              Records will be created in dependency order using the Composite API.
              This operation cannot be automatically rolled back.
            </p>
            <button
              onClick={pushToSalesforce}
              className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-medium rounded-lg
                         bg-primary-600 text-white hover:bg-primary-700 transition-colors"
            >
              <Play className="w-4 h-4" />
              Start Push
            </button>
          </div>
        )}

        {isPushing && (
          <div className="space-y-4">
            <div className="text-center">
              <RefreshCw className="w-8 h-8 mx-auto mb-3 text-primary-500 animate-spin" />
              <p className="text-sm font-medium text-surface-800 dark:text-surface-200">
                Pushing to Salesforce...
              </p>
              <p className="text-xs text-surface-400 mt-1">
                Currently loading: <span className="font-mono font-medium">{pushCurrentObject}</span>
              </p>
            </div>

            {/* Progress bar */}
            <div className="max-w-lg mx-auto">
              <div className="flex items-center justify-between text-xs text-surface-400 mb-1">
                <span>{pushProgress.done} / {pushProgress.total} records</span>
                <span>{progressPct}%</span>
              </div>
              <div className="w-full h-2.5 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Results Step ───────────────────────────────────────────────────────

  const renderResultsStep = () => {
    const successes = results.filter((r) => r.status === 'success');
    const failures = results.filter((r) => r.status === 'error');

    return (
      <div className="space-y-6">
        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            <Package className="w-5 h-5 text-surface-400" />
            <div>
              <p className="text-lg font-bold text-surface-800 dark:text-surface-200">
                {results.length}
              </p>
              <p className="text-xs text-surface-400">Total Processed</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <CheckCircle className="w-5 h-5 text-green-500" />
            <div>
              <p className="text-lg font-bold text-green-700 dark:text-green-400">
                {successes.length}
              </p>
              <p className="text-xs text-green-500">Succeeded</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <XCircle className="w-5 h-5 text-red-500" />
            <div>
              <p className="text-lg font-bold text-red-700 dark:text-red-400">
                {failures.length}
              </p>
              <p className="text-xs text-red-500">Failed</p>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        {failures.length > 0 && (
          <div className="flex items-center gap-3">
            <button
              onClick={downloadErrorCsv}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                         border border-surface-200 dark:border-surface-600 text-surface-700 dark:text-surface-300
                         hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
            >
              <Download className="w-4 h-4" />
              Download Error Report
            </button>
            <button
              onClick={reuploadFailed}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                         bg-amber-600 text-white hover:bg-amber-700 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Re-upload Failed Rows
            </button>
          </div>
        )}

        {/* Results table */}
        <DataTable
          data={results}
          columns={resultColumns}
          title="Operation Results"
          exportFilename="cpq-loader-results"
          pageSize={25}
        />
      </div>
    );
  };

  // =====================================================================
  // Main Render
  // =====================================================================

  const renderCurrentStep = () => {
    switch (step) {
      case 'upload':
        return renderUploadStep();
      case 'mapping':
        return renderMappingStep();
      case 'validation':
        return renderValidationStep();
      case 'preview':
        return renderPreviewStep();
      case 'push':
        return renderPushStep();
      case 'results':
        return renderResultsStep();
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 p-4 border-b border-surface-200 dark:border-surface-700">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-bold text-surface-900 dark:text-surface-100">
              CPQ Product Loader
            </h2>
            <p className="text-xs text-surface-400">
              Load CPQ product data from Excel/CSV into Salesforce
            </p>
          </div>
        </div>

        {/* Reset button */}
        {step !== 'upload' && (
          <button
            onClick={() => {
              setStep('upload');
              setSheets([]);
              setFileName(null);
              setPreviewSheet(null);
              setSheetMappings([]);
              setValidationIssues([]);
              setResults([]);
              setError(null);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                       text-surface-500 hover:text-surface-700 dark:hover:text-surface-300
                       hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Start Over
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {/* Step indicator */}
        {renderStepIndicator()}

        {/* Error */}
        {error && (
          <div className="mb-4">
            <ErrorAlert message={error} onRetry={() => setError(null)} />
          </div>
        )}

        {/* Current step content */}
        {renderCurrentStep()}

        {/* Navigation buttons */}
        {step !== 'results' && (
          <div className="flex items-center justify-between mt-8 pt-4 border-t border-surface-200 dark:border-surface-700">
            <button
              onClick={goBack}
              disabled={stepIndex === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                         border border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-400
                         hover:bg-surface-50 dark:hover:bg-surface-800 disabled:opacity-30 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>

            {step !== 'push' && (
              <button
                onClick={() => {
                  if (step === 'mapping') {
                    // Auto-run validation when moving to validation step
                    goNext();
                    setTimeout(() => runValidation(), 100);
                  } else {
                    goNext();
                  }
                }}
                disabled={!canGoNext()}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                           bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-30 transition-colors"
              >
                Next
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
