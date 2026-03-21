import { useState, useEffect, useCallback, useMemo } from 'react';
import { Database, Search, RefreshCw, Download, Upload, Plus, Trash2, Save, Eye, FileCode } from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import Modal from '@/components/Modal';
import { useAppStore } from '@/services/store';
import { queryAll, describe } from '@/services/salesforce';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetadataTypeInfo {
  qualifiedApiName: string;
  label: string;
  developerName: string;
  recordCount: number | null;
}

interface MetadataField {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  createable: boolean;
  nillable: boolean;
  length: number;
  picklistValues: { label: string; value: string }[];
}

interface MetadataRecord {
  Id: string;
  DeveloperName: string;
  MasterLabel: string;
  [key: string]: unknown;
}

interface RecordChange {
  status: 'new' | 'modified' | 'deleted';
  original: MetadataRecord | null;
  current: MetadataRecord;
}

interface PriorityMatrixCell {
  caseType: string;
  subType: string;
  accountClassification: string;
  recordType: string;
  priority: string;
  record: MetadataRecord;
}

type TabId = 'grid' | 'matrix' | 'diff' | 'import';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the field list for a SOQL query from described fields, excluding
 *  compound/address/location fields that cannot be queried directly. */
function buildFieldList(fields: MetadataField[]): string[] {
  const SKIP_TYPES = new Set(['address', 'location']);
  const ALWAYS_INCLUDE = new Set(['Id', 'DeveloperName', 'MasterLabel', 'Label', 'NamespacePrefix', 'Language', 'QualifiedApiName']);

  return fields
    .filter((f) => !SKIP_TYPES.has(f.type))
    .map((f) => f.name)
    .filter((name) => {
      // Skip system-internal fields that often fail in SOQL for mdt
      if (name === 'IsProtected' || name === 'SystemModstamp' || name === 'CreatedDate' || name === 'LastModifiedDate') return true;
      if (ALWAYS_INCLUDE.has(name)) return true;
      // Include custom fields (__c) and known standard fields
      return name.endsWith('__c') || ALWAYS_INCLUDE.has(name) || ['IsProtected', 'SystemModstamp', 'CreatedDate', 'LastModifiedDate', 'CreatedById', 'LastModifiedById'].includes(name);
    });
}

/** Determine the priority level from a string value. */
function parsePriority(value: unknown): string {
  const str = String(value ?? '').toUpperCase().trim();
  if (str.includes('P1') || str.includes('CRITICAL') || str === '1') return 'P1';
  if (str.includes('P2') || str.includes('HIGH') || str === '2') return 'P2';
  if (str.includes('P3') || str.includes('MEDIUM') || str === '3') return 'P3';
  if (str.includes('P4') || str.includes('LOW') || str === '4') return 'P4';
  return str || 'N/A';
}

/** CSS class for a priority cell. */
function priorityColor(priority: string): string {
  switch (priority) {
    case 'P1': return 'bg-red-500 text-white dark:bg-red-600';
    case 'P2': return 'bg-orange-400 text-white dark:bg-orange-500';
    case 'P3': return 'bg-yellow-300 text-yellow-900 dark:bg-yellow-500 dark:text-yellow-950';
    case 'P4': return 'bg-green-400 text-white dark:bg-green-500';
    default: return 'bg-surface-200 text-surface-600 dark:bg-surface-700 dark:text-surface-300';
  }
}

/** Escape XML special characters. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Generate a metadata XML file for a single custom metadata record. */
function generateMetadataXml(record: MetadataRecord, fields: MetadataField[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"',
    '    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '    xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    `    <label>${escapeXml(String(record.MasterLabel ?? record.DeveloperName ?? ''))}</label>`,
    '    <protected>false</protected>',
  ];

  const SKIP_FIELDS = new Set([
    'Id', 'DeveloperName', 'MasterLabel', 'Label', 'NamespacePrefix',
    'Language', 'QualifiedApiName', 'IsProtected', 'SystemModstamp',
    'CreatedDate', 'LastModifiedDate', 'CreatedById', 'LastModifiedById',
  ]);

  for (const field of fields) {
    if (SKIP_FIELDS.has(field.name)) continue;
    if (!field.name.endsWith('__c')) continue;

    const value = record[field.name];
    if (value === null || value === undefined) continue;

    let xsiType = 'xsd:string';
    if (field.type === 'boolean') xsiType = 'xsd:boolean';
    else if (field.type === 'double' || field.type === 'currency' || field.type === 'percent') xsiType = 'xsd:double';
    else if (field.type === 'date') xsiType = 'xsd:date';
    else if (field.type === 'datetime') xsiType = 'xsd:dateTime';

    lines.push('    <values>');
    lines.push(`        <field>${escapeXml(field.name)}</field>`);
    lines.push(`        <value xsi:type="${xsiType}">${escapeXml(String(value))}</value>`);
    lines.push('    </values>');
  }

  lines.push('</CustomMetadata>');
  return lines.join('\n');
}

/** Generate package.xml content. */
function generatePackageXml(_typeName: string, memberNames: string[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <types>',
    ...memberNames.map((m) => `        <members>${escapeXml(m)}</members>`),
    `        <name>CustomMetadata</name>`,
    '    </types>',
    '    <version>62.0</version>',
    '</Package>',
  ];
  return lines.join('\n');
}

/** Parse CSV text into an array of key-value objects using the first row as headers. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          cells.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }
    cells.push(current);
    return cells;
  };

  const headers = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseRow(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = values[i]?.trim() ?? '';
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MetadataConsole() {
  const { auth } = useAppStore();

  // ── Left panel: type list ───────────────────────────────────────────────
  const [metadataTypes, setMetadataTypes] = useState<MetadataTypeInfo[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [typeSearch, setTypeSearch] = useState('');
  const [selectedType, setSelectedType] = useState<MetadataTypeInfo | null>(null);

  // ── Right panel: records ────────────────────────────────────────────────
  const [records, setRecords] = useState<MetadataRecord[]>([]);
  const [fields, setFields] = useState<MetadataField[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  // ── Editing state ───────────────────────────────────────────────────────
  const [editedRecords, setEditedRecords] = useState<Map<string, RecordChange>>(new Map());
  const [activeTab, setActiveTab] = useState<TabId>('grid');

  // ── Modals ──────────────────────────────────────────────────────────────
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importColumnMap, setImportColumnMap] = useState<Record<string, string>>({});
  const [importPreview, setImportPreview] = useState<Record<string, string>[]>([]);

  // ── Inline edit state ───────────────────────────────────────────────────
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: string } | null>(null);
  const [editingValue, setEditingValue] = useState('');

  // ── Row detail modal ────────────────────────────────────────────────────
  const [detailRecord, setDetailRecord] = useState<MetadataRecord | null>(null);

  // ---------------------------------------------------------------------------
  // Load metadata types
  // ---------------------------------------------------------------------------

  const loadMetadataTypes = useCallback(async () => {
    setTypesLoading(true);
    setTypesError(null);
    try {
      const result = await queryAll<{
        Id?: string;
        QualifiedApiName: string;
        Label: string;
        DeveloperName: string;
      }>(
        "SELECT QualifiedApiName, Label, DeveloperName FROM EntityDefinition WHERE QualifiedApiName LIKE '%__mdt' ORDER BY Label ASC",
      );

      const types: MetadataTypeInfo[] = result.records.map((r) => ({
        qualifiedApiName: r.QualifiedApiName,
        label: r.Label,
        developerName: r.DeveloperName,
        recordCount: null,
      }));

      setMetadataTypes(types);
    } catch (err) {
      setTypesError(err instanceof Error ? err.message : 'Failed to load metadata types');
    } finally {
      setTypesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auth.isAuthenticated) {
      loadMetadataTypes();
    }
  }, [auth.isAuthenticated, loadMetadataTypes]);

  // ---------------------------------------------------------------------------
  // Load records for a selected type
  // ---------------------------------------------------------------------------

  const loadRecords = useCallback(async (typeName: string) => {
    setRecordsLoading(true);
    setRecordsError(null);
    setEditedRecords(new Map());
    setActiveTab('grid');

    try {
      // 1. Describe the object to discover fields
      const describeResult = await describe(typeName);

      const mdtFields: MetadataField[] = describeResult.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        updateable: f.updateable,
        createable: f.createable,
        nillable: f.nillable,
        length: f.length,
        picklistValues: f.picklistValues
          .filter((pv) => pv.active)
          .map((pv) => ({ label: pv.label, value: pv.value })),
      }));

      setFields(mdtFields);

      // 2. Build field list and query all records
      const fieldList = buildFieldList(mdtFields);
      const soql = `SELECT ${fieldList.join(', ')} FROM ${typeName} ORDER BY DeveloperName ASC`;
      const result = await queryAll<MetadataRecord>(soql);

      setRecords(result.records);

      // Update record count in the type list
      setMetadataTypes((prev) =>
        prev.map((t) =>
          t.qualifiedApiName === typeName ? { ...t, recordCount: result.records.length } : t,
        ),
      );
    } catch (err) {
      setRecordsError(err instanceof Error ? err.message : 'Failed to load records');
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  const handleSelectType = useCallback(
    (type: MetadataTypeInfo) => {
      setSelectedType(type);
      loadRecords(type.qualifiedApiName);
    },
    [loadRecords],
  );

  // ---------------------------------------------------------------------------
  // Filtered type list
  // ---------------------------------------------------------------------------

  const filteredTypes = useMemo(() => {
    if (!typeSearch.trim()) return metadataTypes;
    const q = typeSearch.toLowerCase();
    return metadataTypes.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        t.qualifiedApiName.toLowerCase().includes(q) ||
        t.developerName.toLowerCase().includes(q),
    );
  }, [metadataTypes, typeSearch]);

  // ---------------------------------------------------------------------------
  // Editing helpers
  // ---------------------------------------------------------------------------

  /** Get the effective records list with edits applied. */
  const effectiveRecords = useMemo(() => {
    const map = new Map<string, MetadataRecord>();

    // Start with originals
    for (const rec of records) {
      map.set(rec.Id, rec);
    }

    // Apply edits
    for (const [key, change] of editedRecords) {
      if (change.status === 'deleted') {
        map.delete(key);
      } else {
        map.set(key, change.current);
      }
    }

    return Array.from(map.values());
  }, [records, editedRecords]);

  const hasChanges = editedRecords.size > 0;

  const startEdit = useCallback((rowId: string, fieldName: string, currentValue: unknown) => {
    setEditingCell({ rowId, field: fieldName });
    setEditingValue(currentValue == null ? '' : String(currentValue));
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    const { rowId, field } = editingCell;

    const original = records.find((r) => r.Id === rowId) ?? null;
    const existing = editedRecords.get(rowId);
    const current = existing ? { ...existing.current } : original ? { ...original } : null;
    if (!current) return;

    current[field] = editingValue;

    const status: RecordChange['status'] = existing?.status === 'new' ? 'new' : 'modified';

    setEditedRecords((prev) => {
      const next = new Map(prev);
      next.set(rowId, { status, original, current });
      return next;
    });

    setEditingCell(null);
    setEditingValue('');
  }, [editingCell, editingValue, records, editedRecords]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
    setEditingValue('');
  }, []);

  const addNewRow = useCallback(() => {
    const tempId = `__new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newRecord: MetadataRecord = {
      Id: tempId,
      DeveloperName: '',
      MasterLabel: '',
    };

    // Initialize custom fields
    for (const f of fields) {
      if (f.name.endsWith('__c') && f.createable) {
        newRecord[f.name] = '';
      }
    }

    setEditedRecords((prev) => {
      const next = new Map(prev);
      next.set(tempId, { status: 'new', original: null, current: newRecord });
      return next;
    });
  }, [fields]);

  const deleteRow = useCallback((rowId: string) => {
    setEditedRecords((prev) => {
      const next = new Map(prev);
      const existing = next.get(rowId);

      if (existing?.status === 'new') {
        // Remove new row entirely
        next.delete(rowId);
      } else {
        // Mark existing row as deleted
        const original = records.find((r) => r.Id === rowId) ?? null;
        if (original) {
          next.set(rowId, { status: 'deleted', original, current: original });
        }
      }
      return next;
    });
  }, [records]);

  const revertChanges = useCallback(() => {
    setEditedRecords(new Map());
  }, []);

  // ---------------------------------------------------------------------------
  // Column definitions for the grid editor
  // ---------------------------------------------------------------------------

  const editableColumns = useMemo((): ColumnDef<MetadataRecord, unknown>[] => {
    const SKIP_FIELDS = new Set([
      'Id', 'attributes', 'NamespacePrefix', 'Language', 'QualifiedApiName',
      'IsProtected', 'SystemModstamp', 'CreatedById', 'LastModifiedById',
    ]);

    const visibleFields = fields.filter(
      (f) => !SKIP_FIELDS.has(f.name) && f.type !== 'address' && f.type !== 'location',
    );

    // Build columns for visible fields
    const cols: ColumnDef<MetadataRecord, unknown>[] = visibleFields.map((field) => ({
      id: field.name,
      accessorFn: (row: MetadataRecord) => row[field.name],
      header: field.label || field.name,
      cell: ({ row }) => {
        const value = row.original[field.name];
        const rowId = row.original.Id;
        const isEditing = editingCell?.rowId === rowId && editingCell?.field === field.name;
        const change = editedRecords.get(rowId);
        const isModified =
          change &&
          change.status !== 'deleted' &&
          change.original &&
          change.original[field.name] !== row.original[field.name];

        if (isEditing) {
          if (field.type === 'boolean') {
            return (
              <select
                autoFocus
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onBlur={commitEdit}
                className="w-full px-2 py-1 text-sm rounded border border-primary-400 dark:border-primary-500 bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200 focus:outline-none"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            );
          }

          if (field.picklistValues.length > 0) {
            return (
              <select
                autoFocus
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onBlur={commitEdit}
                className="w-full px-2 py-1 text-sm rounded border border-primary-400 dark:border-primary-500 bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200 focus:outline-none"
              >
                <option value="">-- none --</option>
                {field.picklistValues.map((pv) => (
                  <option key={pv.value} value={pv.value}>
                    {pv.label}
                  </option>
                ))}
              </select>
            );
          }

          return (
            <input
              autoFocus
              type={field.type === 'double' || field.type === 'currency' || field.type === 'percent' ? 'number' : 'text'}
              value={editingValue}
              onChange={(e) => setEditingValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit();
                if (e.key === 'Escape') cancelEdit();
              }}
              className="w-full px-2 py-1 text-sm rounded border border-primary-400 dark:border-primary-500 bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200 focus:outline-none"
            />
          );
        }

        const displayValue = value == null ? '' : String(value);
        const isNew = change?.status === 'new';

        return (
          <div
            onDoubleClick={() => startEdit(rowId, field.name, value)}
            className={`cursor-pointer px-1 py-0.5 rounded min-h-[24px] ${
              isNew
                ? 'bg-green-100 dark:bg-green-900/30'
                : isModified
                  ? 'bg-yellow-100 dark:bg-yellow-900/30'
                  : ''
            }`}
            title="Double-click to edit"
          >
            {field.type === 'boolean' ? (
              <StatusBadge
                label={displayValue === 'true' ? 'True' : 'False'}
                variant={displayValue === 'true' ? 'success' : 'neutral'}
              />
            ) : (
              <span className="text-surface-700 dark:text-surface-300">{displayValue || '\u00A0'}</span>
            )}
          </div>
        );
      },
    }));

    // Add actions column
    cols.push({
      id: '_actions',
      header: '',
      cell: ({ row }) => {
        const rowId = row.original.Id;
        const change = editedRecords.get(rowId);
        const isDeleted = change?.status === 'deleted';

        if (isDeleted) {
          return (
            <span className="text-xs text-red-500 italic">Deleted</span>
          );
        }

        return (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDetailRecord(row.original)}
              className="p-1 rounded text-surface-400 hover:text-primary-500 hover:bg-surface-100 dark:hover:bg-surface-800"
              title="View details"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => deleteRow(rowId)}
              className="p-1 rounded text-surface-400 hover:text-red-500 hover:bg-surface-100 dark:hover:bg-surface-800"
              title="Delete row"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      },
      enableSorting: false,
    });

    return cols;
  }, [fields, editingCell, editingValue, editedRecords, startEdit, commitEdit, cancelEdit, deleteRow]);

  // ---------------------------------------------------------------------------
  // Priority Matrix (for Case_Priority_Matrix__mdt)
  // ---------------------------------------------------------------------------

  const isCasePriorityMatrix = selectedType?.qualifiedApiName === 'Case_Priority_Matrix__mdt';

  const matrixData = useMemo(() => {
    if (!isCasePriorityMatrix) return null;

    // Attempt to identify fields used for the matrix axes and value
    // Common patterns: Case_Type__c, Sub_Type__c, Account_Classification__c, Record_Type__c, Priority__c
    const caseTypeField = fields.find(
      (f) =>
        f.name.toLowerCase().includes('case_type') ||
        f.name.toLowerCase().includes('casetype'),
    )?.name;

    const subTypeField = fields.find(
      (f) =>
        f.name.toLowerCase().includes('sub_type') ||
        f.name.toLowerCase().includes('subtype'),
    )?.name;

    const classificationField = fields.find(
      (f) =>
        f.name.toLowerCase().includes('account_classification') ||
        f.name.toLowerCase().includes('classification'),
    )?.name;

    const recordTypeField = fields.find(
      (f) =>
        f.name.toLowerCase().includes('record_type') && !f.name.includes('Id'),
    )?.name;

    const priorityField = fields.find(
      (f) =>
        f.name.toLowerCase().includes('priority'),
    )?.name;

    if (!priorityField) return null;

    const cells: PriorityMatrixCell[] = effectiveRecords.map((rec) => ({
      caseType: String(rec[caseTypeField ?? ''] ?? 'N/A'),
      subType: String(rec[subTypeField ?? ''] ?? ''),
      accountClassification: String(rec[classificationField ?? ''] ?? 'N/A'),
      recordType: String(rec[recordTypeField ?? ''] ?? ''),
      priority: parsePriority(rec[priorityField]),
      record: rec,
    }));

    // Build unique axes
    const xLabels = [...new Set(cells.map((c) => `${c.caseType}${c.subType ? ' / ' + c.subType : ''}`))].sort();
    const yLabels = [...new Set(cells.map((c) => `${c.accountClassification}${c.recordType ? ' / ' + c.recordType : ''}`))].sort();

    // Build a lookup matrix[yLabel][xLabel] = priority
    const matrix: Record<string, Record<string, PriorityMatrixCell>> = {};
    for (const cell of cells) {
      const xKey = `${cell.caseType}${cell.subType ? ' / ' + cell.subType : ''}`;
      const yKey = `${cell.accountClassification}${cell.recordType ? ' / ' + cell.recordType : ''}`;
      if (!matrix[yKey]) matrix[yKey] = {};
      matrix[yKey][xKey] = cell;
    }

    return { xLabels, yLabels, matrix };
  }, [isCasePriorityMatrix, fields, effectiveRecords]);

  // ---------------------------------------------------------------------------
  // Diff computation
  // ---------------------------------------------------------------------------

  const diffEntries = useMemo(() => {
    return Array.from(editedRecords.entries()).map(([id, change]) => {
      const changedFields: { field: string; oldValue: string; newValue: string }[] = [];

      if (change.status === 'new') {
        for (const f of fields) {
          const val = change.current[f.name];
          if (val != null && val !== '') {
            changedFields.push({ field: f.name, oldValue: '', newValue: String(val) });
          }
        }
      } else if (change.status === 'deleted') {
        for (const f of fields) {
          const val = change.original?.[f.name];
          if (val != null && val !== '') {
            changedFields.push({ field: f.name, oldValue: String(val), newValue: '' });
          }
        }
      } else {
        for (const f of fields) {
          const oldVal = change.original?.[f.name];
          const newVal = change.current[f.name];
          if (String(oldVal ?? '') !== String(newVal ?? '')) {
            changedFields.push({
              field: f.name,
              oldValue: String(oldVal ?? ''),
              newValue: String(newVal ?? ''),
            });
          }
        }
      }

      return {
        id,
        developerName: change.current.DeveloperName || change.original?.DeveloperName || id,
        status: change.status,
        changedFields,
      };
    });
  }, [editedRecords, fields]);

  // ---------------------------------------------------------------------------
  // Deploy: generate ZIP package
  // ---------------------------------------------------------------------------

  const generateDeploymentPackage = useCallback(async () => {
    if (!selectedType || !hasChanges) return;

    const zip = new JSZip();
    const typeName = selectedType.qualifiedApiName;
    const typeDevName = typeName.replace('__mdt', '');
    const memberNames: string[] = [];

    for (const [, change] of editedRecords) {
      if (change.status === 'deleted') continue;

      const rec = change.current;
      const devName = rec.DeveloperName || 'Unnamed';
      const fullName = `${typeDevName}.${devName}`;
      memberNames.push(fullName);

      const xml = generateMetadataXml(rec, fields);
      zip.file(`customMetadata/${fullName}.md-meta.xml`, xml);
    }

    // package.xml
    const packageXml = generatePackageXml(typeName, memberNames);
    zip.file('package.xml', packageXml);

    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, `${typeDevName}_metadata_deploy.zip`);
  }, [selectedType, hasChanges, editedRecords, fields]);

  // ---------------------------------------------------------------------------
  // Export CSV
  // ---------------------------------------------------------------------------

  const exportCsv = useCallback(() => {
    if (!selectedType) return;

    const SKIP = new Set(['Id', 'attributes']);
    const exportFields = fields.filter((f) => !SKIP.has(f.name));
    const headers = exportFields.map((f) => f.name);

    const rows = effectiveRecords.map((rec) =>
      headers.map((h) => {
        const val = rec[h];
        const str = val == null ? '' : String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      }),
    );

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `${selectedType.developerName}_records.csv`);
  }, [selectedType, fields, effectiveRecords]);

  // ---------------------------------------------------------------------------
  // Import CSV
  // ---------------------------------------------------------------------------

  const handleImportParse = useCallback(() => {
    const parsed = parseCsv(importText);
    setImportPreview(parsed);

    if (parsed.length > 0) {
      const csvHeaders = Object.keys(parsed[0]);
      const fieldNames = fields.map((f) => f.name);

      // Auto-map: match CSV headers to field names (case-insensitive)
      const mapping: Record<string, string> = {};
      for (const header of csvHeaders) {
        const match = fieldNames.find((fn) => fn.toLowerCase() === header.toLowerCase());
        if (match) {
          mapping[header] = match;
        } else {
          mapping[header] = '';
        }
      }
      setImportColumnMap(mapping);
    }
  }, [importText, fields]);

  const handleImportApply = useCallback(() => {
    if (importPreview.length === 0) return;

    const newEdits = new Map(editedRecords);

    for (const csvRow of importPreview) {
      const tempId = `__new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const newRec: MetadataRecord = {
        Id: tempId,
        DeveloperName: '',
        MasterLabel: '',
      };

      for (const [csvHeader, fieldName] of Object.entries(importColumnMap)) {
        if (fieldName && csvRow[csvHeader] !== undefined) {
          newRec[fieldName] = csvRow[csvHeader];
        }
      }

      newEdits.set(tempId, { status: 'new', original: null, current: newRec });
    }

    setEditedRecords(newEdits);
    setShowImportModal(false);
    setImportText('');
    setImportPreview([]);
    setImportColumnMap({});
  }, [importPreview, importColumnMap, editedRecords]);

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  const tabs: { id: TabId; label: string; show: boolean }[] = [
    { id: 'grid', label: 'Grid Editor', show: true },
    { id: 'matrix', label: 'Priority Matrix', show: isCasePriorityMatrix },
    { id: 'diff', label: `Diff View (${editedRecords.size})`, show: hasChanges },
    { id: 'import', label: 'Import / Export', show: true },
  ];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!auth.isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full">
        <ErrorAlert message="Please log in to access the Metadata Console." />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left Panel: Type Selector ─────────────────────────────────────── */}
      <div className="w-72 shrink-0 border-r border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-900 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-primary-500" />
              <h2 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                Custom Metadata Types
              </h2>
            </div>
            <button
              onClick={loadMetadataTypes}
              disabled={typesLoading}
              className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700 disabled:opacity-50"
              title="Refresh types"
            >
              <RefreshCw className={`w-4 h-4 ${typesLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-400" />
            <input
              type="text"
              placeholder="Search types..."
              value={typeSearch}
              onChange={(e) => setTypeSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                         bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                         focus:outline-none focus:ring-2 focus:ring-primary-500/40"
            />
          </div>
        </div>

        {/* Type List */}
        <div className="flex-1 overflow-y-auto">
          {typesLoading && metadataTypes.length === 0 ? (
            <LoadingSpinner message="Loading metadata types..." />
          ) : typesError ? (
            <div className="p-3">
              <ErrorAlert message={typesError} onRetry={loadMetadataTypes} />
            </div>
          ) : filteredTypes.length === 0 ? (
            <div className="p-4 text-center text-sm text-surface-400">
              {typeSearch ? 'No matching types found' : 'No custom metadata types found'}
            </div>
          ) : (
            <div className="py-1">
              {filteredTypes.map((type) => (
                <button
                  key={type.qualifiedApiName}
                  onClick={() => handleSelectType(type)}
                  className={`w-full text-left px-4 py-2.5 transition-colors border-l-2 ${
                    selectedType?.qualifiedApiName === type.qualifiedApiName
                      ? 'border-l-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                      : 'border-l-transparent hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-700 dark:text-surface-300'
                  }`}
                >
                  <div className="text-sm font-medium truncate">{type.label}</div>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-xs text-surface-400 truncate">{type.qualifiedApiName}</span>
                    {type.recordCount !== null && (
                      <StatusBadge label={`${type.recordCount}`} variant="info" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Summary footer */}
        <div className="px-4 py-2 border-t border-surface-200 dark:border-surface-700 text-xs text-surface-400">
          {metadataTypes.length} type{metadataTypes.length !== 1 ? 's' : ''} found
        </div>
      </div>

      {/* ── Right Panel: Records ──────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-surface-950">
        {!selectedType ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-surface-400">
            <Database className="w-12 h-12 opacity-30" />
            <p className="text-sm">Select a custom metadata type from the left panel</p>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-900">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-surface-800 dark:text-surface-200">
                    {selectedType.label}
                  </h2>
                  <StatusBadge
                    label={`${effectiveRecords.length} records`}
                    variant="info"
                  />
                  {hasChanges && (
                    <StatusBadge
                      label={`${editedRecords.size} change${editedRecords.size !== 1 ? 's' : ''}`}
                      variant="warning"
                    />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={addNewRow}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg
                               bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add Row
                  </button>
                  <button
                    onClick={() => setShowDiffModal(true)}
                    disabled={!hasChanges}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg
                               border border-surface-300 dark:border-surface-600
                               text-surface-700 dark:text-surface-300
                               hover:bg-surface-100 dark:hover:bg-surface-800
                               disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Eye className="w-4 h-4" />
                    Diff
                  </button>
                  <button
                    onClick={generateDeploymentPackage}
                    disabled={!hasChanges}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg
                               bg-green-600 text-white hover:bg-green-700
                               disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <FileCode className="w-4 h-4" />
                    Generate Package
                  </button>
                  <button
                    onClick={revertChanges}
                    disabled={!hasChanges}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg
                               border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400
                               hover:bg-red-50 dark:hover:bg-red-900/20
                               disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    Revert All
                  </button>
                  <button
                    onClick={() => loadRecords(selectedType.qualifiedApiName)}
                    disabled={recordsLoading}
                    className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700 disabled:opacity-50"
                    title="Refresh records"
                  >
                    <RefreshCw className={`w-4 h-4 ${recordsLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-1">
                {tabs
                  .filter((t) => t.show)
                  .map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                        activeTab === tab.id
                          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                          : 'text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4">
              {recordsLoading ? (
                <LoadingSpinner message="Loading records..." />
              ) : recordsError ? (
                <ErrorAlert
                  message={recordsError}
                  onRetry={() => loadRecords(selectedType.qualifiedApiName)}
                />
              ) : (
                <>
                  {/* ── Grid Editor Tab ────────────────────────────────────── */}
                  {activeTab === 'grid' && (
                    <DataTable
                      data={effectiveRecords}
                      columns={editableColumns}
                      title={selectedType.label}
                      searchable
                      exportable
                      exportFilename={selectedType.developerName}
                      pageSize={50}
                    />
                  )}

                  {/* ── Priority Matrix Tab ────────────────────────────────── */}
                  {activeTab === 'matrix' && isCasePriorityMatrix && (
                    <div className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden bg-white dark:bg-surface-900">
                      <div className="p-3 border-b border-surface-200 dark:border-surface-700">
                        <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                          Case Priority Matrix
                        </h3>
                        <p className="text-xs text-surface-400 mt-0.5">
                          X-axis: Case Type + SubType | Y-axis: Account Classification + Record Type
                        </p>
                      </div>
                      {matrixData ? (
                        <div className="overflow-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-surface-200 dark:border-surface-700">
                                <th className="px-3 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 bg-surface-50 dark:bg-surface-800 sticky left-0 z-10">
                                  Classification / Record Type
                                </th>
                                {matrixData.xLabels.map((xLabel) => (
                                  <th
                                    key={xLabel}
                                    className="px-3 py-2 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 bg-surface-50 dark:bg-surface-800 whitespace-nowrap"
                                  >
                                    {xLabel}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {matrixData.yLabels.map((yLabel) => (
                                <tr key={yLabel} className="border-b border-surface-100 dark:border-surface-800">
                                  <td className="px-3 py-2 text-sm font-medium text-surface-700 dark:text-surface-300 bg-surface-50 dark:bg-surface-800 sticky left-0 z-10 whitespace-nowrap">
                                    {yLabel}
                                  </td>
                                  {matrixData.xLabels.map((xLabel) => {
                                    const cell = matrixData.matrix[yLabel]?.[xLabel];
                                    const priority = cell?.priority ?? '';
                                    return (
                                      <td key={xLabel} className="px-1 py-1 text-center">
                                        {priority ? (
                                          <span
                                            className={`inline-block px-3 py-1.5 rounded-lg text-xs font-bold ${priorityColor(priority)}`}
                                            title={`${yLabel} x ${xLabel}`}
                                          >
                                            {priority}
                                          </span>
                                        ) : (
                                          <span className="text-surface-300 dark:text-surface-600 text-xs">--</span>
                                        )}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="p-6 text-center text-sm text-surface-400">
                          Unable to detect priority matrix fields. Ensure the metadata type has
                          Case_Type, Sub_Type, Account_Classification, Record_Type, and Priority fields.
                        </div>
                      )}

                      {/* Legend */}
                      <div className="flex items-center gap-3 px-4 py-2 border-t border-surface-200 dark:border-surface-700">
                        <span className="text-xs text-surface-500 dark:text-surface-400 font-medium">Legend:</span>
                        {['P1', 'P2', 'P3', 'P4'].map((p) => (
                          <span key={p} className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${priorityColor(p)}`}>
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Diff View Tab ──────────────────────────────────────── */}
                  {activeTab === 'diff' && hasChanges && (
                    <div className="space-y-4">
                      {diffEntries.map((entry) => (
                        <div
                          key={entry.id}
                          className={`border rounded-xl overflow-hidden ${
                            entry.status === 'new'
                              ? 'border-green-300 dark:border-green-700'
                              : entry.status === 'deleted'
                                ? 'border-red-300 dark:border-red-700'
                                : 'border-yellow-300 dark:border-yellow-700'
                          }`}
                        >
                          <div
                            className={`px-4 py-2 text-sm font-semibold ${
                              entry.status === 'new'
                                ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : entry.status === 'deleted'
                                  ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                  : 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                            }`}
                          >
                            <StatusBadge
                              label={entry.status.toUpperCase()}
                              variant={
                                entry.status === 'new'
                                  ? 'success'
                                  : entry.status === 'deleted'
                                    ? 'danger'
                                    : 'warning'
                              }
                            />
                            <span className="ml-2">{entry.developerName}</span>
                          </div>
                          {entry.changedFields.length > 0 && (
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-surface-200 dark:border-surface-700">
                                  <th className="px-4 py-1.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 w-1/4">Field</th>
                                  <th className="px-4 py-1.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 w-[37.5%]">Before</th>
                                  <th className="px-4 py-1.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 w-[37.5%]">After</th>
                                </tr>
                              </thead>
                              <tbody>
                                {entry.changedFields.map((cf) => (
                                  <tr key={cf.field} className="border-b border-surface-100 dark:border-surface-800">
                                    <td className="px-4 py-1.5 text-surface-600 dark:text-surface-400 font-medium">
                                      {cf.field}
                                    </td>
                                    <td className="px-4 py-1.5">
                                      {cf.oldValue ? (
                                        <span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-1.5 py-0.5 rounded text-xs">
                                          {cf.oldValue}
                                        </span>
                                      ) : (
                                        <span className="text-surface-300 dark:text-surface-600 text-xs italic">empty</span>
                                      )}
                                    </td>
                                    <td className="px-4 py-1.5">
                                      {cf.newValue ? (
                                        <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded text-xs">
                                          {cf.newValue}
                                        </span>
                                      ) : (
                                        <span className="text-surface-300 dark:text-surface-600 text-xs italic">empty</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Import / Export Tab ─────────────────────────────────── */}
                  {activeTab === 'import' && (
                    <div className="space-y-6">
                      {/* Export section */}
                      <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-white dark:bg-surface-900">
                        <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-2">
                          Export Records
                        </h3>
                        <p className="text-xs text-surface-400 mb-3">
                          Download all {effectiveRecords.length} records as a CSV file.
                        </p>
                        <button
                          onClick={exportCsv}
                          disabled={effectiveRecords.length === 0}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg
                                     bg-primary-600 text-white hover:bg-primary-700
                                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <Download className="w-4 h-4" />
                          Export CSV
                        </button>
                      </div>

                      {/* Import section */}
                      <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-white dark:bg-surface-900">
                        <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-2">
                          Import Records
                        </h3>
                        <p className="text-xs text-surface-400 mb-3">
                          Paste CSV data or upload a CSV file to import records. Column mapping is available after parsing.
                        </p>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => setShowImportModal(true)}
                            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg
                                       border border-surface-300 dark:border-surface-600
                                       text-surface-700 dark:text-surface-300
                                       hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                          >
                            <Upload className="w-4 h-4" />
                            Import CSV
                          </button>
                          <label className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg
                                            border border-surface-300 dark:border-surface-600
                                            text-surface-700 dark:text-surface-300
                                            hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors cursor-pointer">
                            <Upload className="w-4 h-4" />
                            Upload File
                            <input
                              type="file"
                              accept=".csv"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const reader = new FileReader();
                                reader.onload = () => {
                                  setImportText(reader.result as string);
                                  setShowImportModal(true);
                                };
                                reader.readAsText(file);
                              }}
                            />
                          </label>
                        </div>
                      </div>

                      {/* Deploy section */}
                      <div className="border border-surface-200 dark:border-surface-700 rounded-xl p-4 bg-white dark:bg-surface-900">
                        <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-2">
                          Generate Deployment Package
                        </h3>
                        <p className="text-xs text-surface-400 mb-3">
                          Create a deployable ZIP containing metadata XML files for all changed records.
                          {!hasChanges && ' Make some changes first to enable this.'}
                        </p>
                        <button
                          onClick={generateDeploymentPackage}
                          disabled={!hasChanges}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg
                                     bg-green-600 text-white hover:bg-green-700
                                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <FileCode className="w-4 h-4" />
                          Generate Package (.zip)
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Diff Modal ────────────────────────────────────────────────────── */}
      <Modal open={showDiffModal} onClose={() => setShowDiffModal(false)} title="Change Diff" wide>
        {diffEntries.length === 0 ? (
          <p className="text-sm text-surface-400">No changes to display.</p>
        ) : (
          <div className="space-y-4">
            {diffEntries.map((entry) => (
              <div
                key={entry.id}
                className={`border rounded-xl overflow-hidden ${
                  entry.status === 'new'
                    ? 'border-green-300 dark:border-green-700'
                    : entry.status === 'deleted'
                      ? 'border-red-300 dark:border-red-700'
                      : 'border-yellow-300 dark:border-yellow-700'
                }`}
              >
                <div
                  className={`px-4 py-2 flex items-center gap-2 ${
                    entry.status === 'new'
                      ? 'bg-green-50 dark:bg-green-900/30'
                      : entry.status === 'deleted'
                        ? 'bg-red-50 dark:bg-red-900/30'
                        : 'bg-yellow-50 dark:bg-yellow-900/30'
                  }`}
                >
                  <StatusBadge
                    label={entry.status.toUpperCase()}
                    variant={
                      entry.status === 'new'
                        ? 'success'
                        : entry.status === 'deleted'
                          ? 'danger'
                          : 'warning'
                    }
                  />
                  <span className="text-sm font-medium text-surface-800 dark:text-surface-200">
                    {entry.developerName}
                  </span>
                </div>
                {entry.changedFields.length > 0 && (
                  <div className="divide-y divide-surface-100 dark:divide-surface-800">
                    {entry.changedFields.map((cf) => (
                      <div key={cf.field} className="px-4 py-2 grid grid-cols-3 gap-4 text-sm">
                        <span className="text-surface-600 dark:text-surface-400 font-medium">{cf.field}</span>
                        <div>
                          {cf.oldValue ? (
                            <span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-2 py-0.5 rounded text-xs font-mono">
                              {cf.oldValue}
                            </span>
                          ) : (
                            <span className="text-surface-300 dark:text-surface-600 text-xs italic">empty</span>
                          )}
                        </div>
                        <div>
                          {cf.newValue ? (
                            <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-2 py-0.5 rounded text-xs font-mono">
                              {cf.newValue}
                            </span>
                          ) : (
                            <span className="text-surface-300 dark:text-surface-600 text-xs italic">empty</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* ── Import Modal ──────────────────────────────────────────────────── */}
      <Modal open={showImportModal} onClose={() => setShowImportModal(false)} title="Import CSV" wide>
        <div className="space-y-4">
          {/* CSV input */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">
              Paste CSV Data
            </label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="DeveloperName,MasterLabel,Field1__c,Field2__c&#10;Record1,My Record,value1,value2"
              rows={8}
              className="w-full px-3 py-2 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                         bg-surface-50 dark:bg-surface-800 text-surface-800 dark:text-surface-200
                         focus:outline-none focus:ring-2 focus:ring-primary-500/40 font-mono"
            />
          </div>

          <button
            onClick={handleImportParse}
            disabled={!importText.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg
                       bg-primary-600 text-white hover:bg-primary-700
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Search className="w-4 h-4" />
            Parse & Map Columns
          </button>

          {/* Column mapping */}
          {importPreview.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-2">
                Column Mapping ({importPreview.length} rows detected)
              </h4>
              <div className="border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800">
                      <th className="px-3 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400">
                        CSV Column
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400">
                        Maps To Field
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400">
                        Sample Value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(importColumnMap).map((csvHeader) => (
                      <tr key={csvHeader} className="border-b border-surface-100 dark:border-surface-800">
                        <td className="px-3 py-2 text-surface-700 dark:text-surface-300 font-mono text-xs">
                          {csvHeader}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={importColumnMap[csvHeader]}
                            onChange={(e) =>
                              setImportColumnMap((prev) => ({
                                ...prev,
                                [csvHeader]: e.target.value,
                              }))
                            }
                            className="w-full px-2 py-1 text-sm rounded border border-surface-200 dark:border-surface-600
                                       bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                                       focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                          >
                            <option value="">-- skip --</option>
                            {fields.map((f) => (
                              <option key={f.name} value={f.name}>
                                {f.label} ({f.name})
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-surface-400 text-xs font-mono truncate max-w-[200px]">
                          {importPreview[0]?.[csvHeader] ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end mt-3">
                <button
                  onClick={handleImportApply}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg
                             bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  <Save className="w-4 h-4" />
                  Import {importPreview.length} Record{importPreview.length !== 1 ? 's' : ''}
                </button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* ── Record Detail Modal ───────────────────────────────────────────── */}
      <Modal
        open={detailRecord !== null}
        onClose={() => setDetailRecord(null)}
        title={`Record: ${detailRecord?.DeveloperName ?? ''}`}
        wide
      >
        {detailRecord && (
          <div className="divide-y divide-surface-100 dark:divide-surface-800">
            {fields
              .filter((f) => f.name !== 'attributes')
              .map((f) => {
                const value = detailRecord[f.name];
                return (
                  <div key={f.name} className="grid grid-cols-3 gap-4 py-2 text-sm">
                    <span className="text-surface-500 dark:text-surface-400 font-medium">{f.label}</span>
                    <span className="text-xs text-surface-400 font-mono">{f.name}</span>
                    <span className="text-surface-800 dark:text-surface-200 font-mono text-xs">
                      {value == null ? (
                        <span className="text-surface-300 dark:text-surface-600 italic">null</span>
                      ) : (
                        String(value)
                      )}
                    </span>
                  </div>
                );
              })}
          </div>
        )}
      </Modal>
    </div>
  );
}
