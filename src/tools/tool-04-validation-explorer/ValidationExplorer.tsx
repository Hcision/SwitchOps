import { useState, useEffect, useCallback, useMemo } from 'react';
import { CheckSquare, Search, RefreshCw, Play, ChevronDown, ChevronUp, Filter } from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import { toolingQuery, sfRequest } from '@/services/salesforce';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidationRuleMetadata {
  active: boolean;
  description: string | null;
  errorConditionFormula: string;
  errorDisplayField: string | null;
  errorMessage: string;
  urls: null;
}

interface ValidationRuleRecord {
  Id: string;
  EntityDefinition: {
    QualifiedApiName: string;
  };
  ValidationName: string;
  Active: boolean;
  Description: string | null;
  ErrorDisplayField: string | null;
  ErrorMessage: string;
  FullName: string;
}

interface ValidationRuleDetailResponse {
  Id: string;
  Metadata: ValidationRuleMetadata;
  [key: string]: unknown;
}

interface ParsedValidationRule {
  id: string;
  objectName: string;
  fullName: string;
  ruleName: string;
  active: boolean;
  description: string | null;
  formula: string;
  errorMessage: string;
  errorDisplayField: string | null;
  englishDescription: string;
  lastModified: string;
}

interface ObjectSummary {
  objectName: string;
  ruleCount: number;
  activeCount: number;
  formulaFieldCount: number;
}

interface SimulatorFieldValue {
  [fieldName: string]: string;
}

interface SimulatorResult {
  ruleName: string;
  passed: boolean;
  errorMessage: string;
  formula: string;
}

type TabId = 'rules' | 'simulator' | 'cross-object';

// ---------------------------------------------------------------------------
// Formula Parser: convert Salesforce formula to plain English
// ---------------------------------------------------------------------------

export function parseFormulaToEnglish(formula: string): string {
  if (!formula || formula.trim().length === 0) return 'No formula defined';

  const trimmed = formula.trim();

  // 1. Simple ISBLANK / ISBLANK with NOT
  const isblankMatch = trimmed.match(/^ISBLANK\(\s*([^)]+)\s*\)$/i);
  if (isblankMatch) {
    return `${cleanFieldName(isblankMatch[1])} is blank`;
  }

  const notIsblankMatch = trimmed.match(/^NOT\(\s*ISBLANK\(\s*([^)]+)\s*\)\s*\)$/i);
  if (notIsblankMatch) {
    return `${cleanFieldName(notIsblankMatch[1])} must not be empty`;
  }

  // 2. ISNULL
  const isnullMatch = trimmed.match(/^ISNULL\(\s*([^)]+)\s*\)$/i);
  if (isnullMatch) {
    return `${cleanFieldName(isnullMatch[1])} is null`;
  }

  // 3. ISPICKVAL
  const ispickvalMatch = trimmed.match(/^ISPICKVAL\(\s*([^,]+)\s*,\s*'([^']*)'\s*\)$/i);
  if (ispickvalMatch) {
    const fieldName = cleanFieldName(ispickvalMatch[1]);
    const value = ispickvalMatch[2];
    return value === '' ? `${fieldName} is not set` : `When ${fieldName} is '${value}'`;
  }

  // 4. NOT(ISPICKVAL(...))
  const notIspickvalMatch = trimmed.match(
    /^NOT\(\s*ISPICKVAL\(\s*([^,]+)\s*,\s*'([^']*)'\s*\)\s*\)$/i,
  );
  if (notIspickvalMatch) {
    const fieldName = cleanFieldName(notIspickvalMatch[1]);
    const value = notIspickvalMatch[2];
    return `When ${fieldName} is not '${value}'`;
  }

  // 5. LEN(...) > N  or  LEN(...) < N
  const lenGtMatch = trimmed.match(/^LEN\(\s*([^)]+)\s*\)\s*>\s*(\d+)$/i);
  if (lenGtMatch) {
    return `${cleanFieldName(lenGtMatch[1])} length must not exceed ${lenGtMatch[2]} characters`;
  }
  const lenLtMatch = trimmed.match(/^LEN\(\s*([^)]+)\s*\)\s*<\s*(\d+)$/i);
  if (lenLtMatch) {
    return `${cleanFieldName(lenLtMatch[1])} must be at least ${lenLtMatch[2]} characters long`;
  }

  // 6. CONTAINS
  const containsMatch = trimmed.match(/^CONTAINS\(\s*([^,]+)\s*,\s*'([^']*)'\s*\)$/i);
  if (containsMatch) {
    return `${cleanFieldName(containsMatch[1])} must contain '${containsMatch[2]}'`;
  }

  // 7. Simple field == value comparisons
  const eqStringMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*==?\s*'([^']*)'$/);
  if (eqStringMatch) {
    return `${cleanFieldName(eqStringMatch[1])} equals '${eqStringMatch[2]}'`;
  }
  const neqStringMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*!=\s*'([^']*)'$/);
  if (neqStringMatch) {
    return `${cleanFieldName(neqStringMatch[1])} does not equal '${neqStringMatch[2]}'`;
  }
  const eqNullMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*==?\s*null$/i);
  if (eqNullMatch) {
    return `${cleanFieldName(eqNullMatch[1])} is null`;
  }
  const neqNullMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*!=\s*null$/i);
  if (neqNullMatch) {
    return `${cleanFieldName(neqNullMatch[1])} is not null`;
  }

  // 8. AND(...) - try to parse inner conditions
  const andMatch = trimmed.match(/^AND\(\s*([\s\S]+)\s*\)$/i);
  if (andMatch) {
    const innerParts = splitFormulaArgs(andMatch[1]);
    if (innerParts.length > 0 && innerParts.length <= 5) {
      const descriptions = innerParts.map((p) => parseFormulaToEnglish(p.trim()));
      const allParsed = descriptions.every((d) => !d.startsWith('Formula:'));
      if (allParsed) {
        return `All of: ${descriptions.join('; ')}`;
      }
    }
  }

  // 9. OR(...) - try to parse inner conditions
  const orMatch = trimmed.match(/^OR\(\s*([\s\S]+)\s*\)$/i);
  if (orMatch) {
    const innerParts = splitFormulaArgs(orMatch[1]);
    if (innerParts.length > 0 && innerParts.length <= 5) {
      const descriptions = innerParts.map((p) => parseFormulaToEnglish(p.trim()));
      const allParsed = descriptions.every((d) => !d.startsWith('Formula:'));
      if (allParsed) {
        return `Any of: ${descriptions.join('; ')}`;
      }
    }
  }

  // 10. NOT(...)
  const notMatch = trimmed.match(/^NOT\(\s*([\s\S]+)\s*\)$/i);
  if (notMatch) {
    const inner = parseFormulaToEnglish(notMatch[1].trim());
    if (!inner.startsWith('Formula:')) {
      return `NOT: ${inner}`;
    }
  }

  // 11. REGEX
  const regexMatch = trimmed.match(/^REGEX\(\s*([^,]+)\s*,\s*"([^"]*)"\s*\)$/i);
  if (regexMatch) {
    return `${cleanFieldName(regexMatch[1])} must match pattern "${regexMatch[2]}"`;
  }

  // Fallback: show truncated formula
  const truncated = trimmed.length > 120 ? trimmed.substring(0, 120) + '...' : trimmed;
  return `Formula: ${truncated}`;
}

/** Strip __c suffix and replace underscores with spaces for readability. */
function cleanFieldName(raw: string): string {
  return raw
    .trim()
    .replace(/__c$/i, '')
    .replace(/__r\./g, ' > ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split comma-separated formula arguments respecting nested parentheses.
 * e.g. "ISBLANK(A), ISPICKVAL(B, 'C')" => ["ISBLANK(A)", "ISPICKVAL(B, 'C')"]
 */
function splitFormulaArgs(argsStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    const prev = i > 0 ? argsStr[i - 1] : '';

    if (inString) {
      current += ch;
      if (ch === stringChar && prev !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Client-Side Formula Evaluator (for the "What Blocks Me?" Simulator)
// ---------------------------------------------------------------------------

function evaluateFormula(
  formula: string,
  fieldValues: SimulatorFieldValue,
): boolean {
  try {
    return evalNode(formula.trim(), fieldValues);
  } catch {
    // If evaluation fails, assume rule does not fire (pass)
    return false;
  }
}

function evalNode(expr: string, values: SimulatorFieldValue): boolean {
  const trimmed = expr.trim();

  // AND(...)
  const andMatch = trimmed.match(/^AND\(\s*([\s\S]+)\s*\)$/i);
  if (andMatch) {
    const args = splitFormulaArgs(andMatch[1]);
    return args.every((a) => evalNode(a.trim(), values));
  }

  // OR(...)
  const orMatch = trimmed.match(/^OR\(\s*([\s\S]+)\s*\)$/i);
  if (orMatch) {
    const args = splitFormulaArgs(orMatch[1]);
    return args.some((a) => evalNode(a.trim(), values));
  }

  // NOT(...)
  const notMatch = trimmed.match(/^NOT\(\s*([\s\S]+)\s*\)$/i);
  if (notMatch) {
    return !evalNode(notMatch[1].trim(), values);
  }

  // ISBLANK(field)
  const isblankMatch = trimmed.match(/^ISBLANK\(\s*([^)]+)\s*\)$/i);
  if (isblankMatch) {
    const fieldName = isblankMatch[1].trim();
    const val = resolveFieldValue(fieldName, values);
    return val === '' || val === undefined || val === null;
  }

  // ISNULL(field)
  const isnullMatch = trimmed.match(/^ISNULL\(\s*([^)]+)\s*\)$/i);
  if (isnullMatch) {
    const fieldName = isnullMatch[1].trim();
    const val = resolveFieldValue(fieldName, values);
    return val === '' || val === undefined || val === null;
  }

  // ISPICKVAL(field, 'value')
  const ispickvalMatch = trimmed.match(/^ISPICKVAL\(\s*([^,]+)\s*,\s*'([^']*)'\s*\)$/i);
  if (ispickvalMatch) {
    const fieldName = ispickvalMatch[1].trim();
    const expected = ispickvalMatch[2];
    const val = resolveFieldValue(fieldName, values);
    return val === expected;
  }

  // CONTAINS(field, 'text')
  const containsMatch = trimmed.match(/^CONTAINS\(\s*([^,]+)\s*,\s*'([^']*)'\s*\)$/i);
  if (containsMatch) {
    const fieldName = containsMatch[1].trim();
    const substring = containsMatch[2];
    const val = resolveFieldValue(fieldName, values) ?? '';
    return val.includes(substring);
  }

  // LEN(field) > N / LEN(field) < N / LEN(field) = N etc.
  const lenCompareMatch = trimmed.match(/^LEN\(\s*([^)]+)\s*\)\s*([><=!]+)\s*(\d+)$/i);
  if (lenCompareMatch) {
    const fieldName = lenCompareMatch[1].trim();
    const op = lenCompareMatch[2];
    const threshold = parseInt(lenCompareMatch[3], 10);
    const val = resolveFieldValue(fieldName, values) ?? '';
    const len = val.length;
    return compareValues(len, op, threshold);
  }

  // IF(condition, trueVal, falseVal) - evaluate condition only
  const ifMatch = trimmed.match(/^IF\(\s*([\s\S]+)\s*\)$/i);
  if (ifMatch) {
    const args = splitFormulaArgs(ifMatch[1]);
    if (args.length >= 1) {
      return evalNode(args[0].trim(), values);
    }
  }

  // Field == 'value'
  const eqStringMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*={1,2}\s*'([^']*)'$/);
  if (eqStringMatch) {
    const val = resolveFieldValue(eqStringMatch[1].trim(), values) ?? '';
    return val === eqStringMatch[2];
  }

  // Field != 'value'
  const neqStringMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*!=\s*'([^']*)'$/);
  if (neqStringMatch) {
    const val = resolveFieldValue(neqStringMatch[1].trim(), values) ?? '';
    return val !== neqStringMatch[2];
  }

  // Field == null
  const eqNullMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*={1,2}\s*null$/i);
  if (eqNullMatch) {
    const val = resolveFieldValue(eqNullMatch[1].trim(), values);
    return val === '' || val === undefined || val === null;
  }

  // Field != null
  const neqNullMatch = trimmed.match(/^([A-Za-z0-9_.]+)\s*!=\s*null$/i);
  if (neqNullMatch) {
    const val = resolveFieldValue(neqNullMatch[1].trim(), values);
    return val !== '' && val !== undefined && val !== null;
  }

  // Boolean field references: TRUE / FALSE
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;

  // Plain field reference (truthy check)
  if (/^[A-Za-z0-9_.]+$/.test(trimmed)) {
    const val = resolveFieldValue(trimmed, values);
    return val !== '' && val !== undefined && val !== null && val !== 'false';
  }

  // Cannot evaluate - assume false (rule does not fire)
  return false;
}

function resolveFieldValue(
  fieldName: string,
  values: SimulatorFieldValue,
): string | undefined {
  // Try exact match first, then case-insensitive
  if (fieldName in values) return values[fieldName];
  const lower = fieldName.toLowerCase();
  for (const key of Object.keys(values)) {
    if (key.toLowerCase() === lower) return values[key];
  }
  return undefined;
}

function compareValues(left: number, op: string, right: number): boolean {
  switch (op) {
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '==': case '=': return left === right;
    case '!=': return left !== right;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Extract field names referenced in a formula (for the simulator form)
// ---------------------------------------------------------------------------

function extractFieldNames(formula: string): string[] {
  const fields = new Set<string>();

  // Match ISBLANK(Field), ISNULL(Field)
  const blankNullRegex = /(?:ISBLANK|ISNULL)\(\s*([A-Za-z0-9_.]+)\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = blankNullRegex.exec(formula)) !== null) {
    fields.add(m[1]);
  }

  // Match ISPICKVAL(Field, 'value')
  const pickvalRegex = /ISPICKVAL\(\s*([A-Za-z0-9_.]+)\s*,/gi;
  while ((m = pickvalRegex.exec(formula)) !== null) {
    fields.add(m[1]);
  }

  // Match CONTAINS(Field, 'value')
  const containsRegex = /CONTAINS\(\s*([A-Za-z0-9_.]+)\s*,/gi;
  while ((m = containsRegex.exec(formula)) !== null) {
    fields.add(m[1]);
  }

  // Match LEN(Field)
  const lenRegex = /LEN\(\s*([A-Za-z0-9_.]+)\s*\)/gi;
  while ((m = lenRegex.exec(formula)) !== null) {
    fields.add(m[1]);
  }

  // Match REGEX(Field, ...)
  const regexRegex = /REGEX\(\s*([A-Za-z0-9_.]+)\s*,/gi;
  while ((m = regexRegex.exec(formula)) !== null) {
    fields.add(m[1]);
  }

  // Match Field == 'value' or Field != 'value' patterns
  const compRegex = /([A-Za-z0-9_.]+)\s*[!=<>]+\s*(?:'[^']*'|null|\d+)/gi;
  while ((m = compRegex.exec(formula)) !== null) {
    const candidate = m[1].toUpperCase();
    // Skip known function names
    if (!['AND', 'OR', 'NOT', 'IF', 'LEN', 'ISBLANK', 'ISNULL', 'ISPICKVAL', 'CONTAINS', 'REGEX'].includes(candidate)) {
      fields.add(m[1]);
    }
  }

  return Array.from(fields).sort();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ValidationExplorer() {
  // ── State ──────────────────────────────────────────────────────────────

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<ParsedValidationRule[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('rules');

  // Object selector
  const [selectedObject, setSelectedObject] = useState<string>('');

  // Search
  const [searchTerm, setSearchTerm] = useState('');

  // Expanded rule cards (to show/hide raw formula)
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());

  // Simulator
  const [simulatorObject, setSimulatorObject] = useState<string>('');
  const [simulatorFieldValues, setSimulatorFieldValues] = useState<SimulatorFieldValue>({});
  const [simulatorResults, setSimulatorResults] = useState<SimulatorResult[] | null>(null);

  // Active filter for rule list
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');

  // ── Derived data ───────────────────────────────────────────────────────

  const objectSummaries = useMemo<ObjectSummary[]>(() => {
    const summaryMap = new Map<string, { total: number; active: number; formulas: Set<string> }>();

    for (const rule of rules) {
      const existing = summaryMap.get(rule.objectName) ?? { total: 0, active: 0, formulas: new Set<string>() };
      existing.total++;
      if (rule.active) existing.active++;
      // Count fields referenced in formulas as a proxy for "formula fields"
      const fields = extractFieldNames(rule.formula);
      for (const f of fields) existing.formulas.add(f);
      summaryMap.set(rule.objectName, existing);
    }

    return Array.from(summaryMap.entries())
      .map(([objectName, data]) => ({
        objectName,
        ruleCount: data.total,
        activeCount: data.active,
        formulaFieldCount: data.formulas.size,
      }))
      .sort((a, b) => b.ruleCount - a.ruleCount);
  }, [rules]);

  const objectNames = useMemo(
    () => objectSummaries.map((s) => s.objectName),
    [objectSummaries],
  );

  const filteredRules = useMemo(() => {
    let result = rules;

    // Filter by object
    if (selectedObject) {
      result = result.filter((r) => r.objectName === selectedObject);
    }

    // Filter by active/inactive
    if (activeFilter === 'active') {
      result = result.filter((r) => r.active);
    } else if (activeFilter === 'inactive') {
      result = result.filter((r) => !r.active);
    }

    // Search filter
    if (searchTerm.trim()) {
      const lower = searchTerm.toLowerCase();
      result = result.filter(
        (r) =>
          r.ruleName.toLowerCase().includes(lower) ||
          r.formula.toLowerCase().includes(lower) ||
          r.errorMessage.toLowerCase().includes(lower) ||
          r.englishDescription.toLowerCase().includes(lower) ||
          r.objectName.toLowerCase().includes(lower),
      );
    }

    return result;
  }, [rules, selectedObject, activeFilter, searchTerm]);

  // Simulator fields: extract from all active rules on the selected object
  const simulatorFields = useMemo(() => {
    if (!simulatorObject) return [];
    const objectRules = rules.filter((r) => r.objectName === simulatorObject && r.active);
    const allFields = new Set<string>();
    for (const rule of objectRules) {
      const fields = extractFieldNames(rule.formula);
      for (const f of fields) allFields.add(f);
    }
    return Array.from(allFields).sort();
  }, [simulatorObject, rules]);

  // ── Data fetching ──────────────────────────────────────────────────────

  const fetchValidationRules = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const soql =
        'SELECT Id, EntityDefinition.QualifiedApiName, ValidationName, Active, Description, ErrorDisplayField, ErrorMessage, FullName FROM ValidationRule';
      const result = await toolingQuery<ValidationRuleRecord>(soql);

      // Build initial parsed rules without formulas (which require separate REST calls)
      const parsed: ParsedValidationRule[] = result.records.map((rec) => {
        const objectName = rec.EntityDefinition?.QualifiedApiName ?? 'Unknown';
        const fullName = rec.FullName ?? '';
        const dotIndex = fullName.indexOf('.');
        const ruleName = dotIndex >= 0 ? fullName.substring(dotIndex + 1) : (rec.ValidationName ?? fullName);

        return {
          id: rec.Id ?? fullName,
          objectName,
          fullName,
          ruleName,
          active: rec.Active ?? false,
          description: rec.Description ?? null,
          formula: 'Loading formula...',
          errorMessage: rec.ErrorMessage ?? '',
          errorDisplayField: rec.ErrorDisplayField ?? null,
          englishDescription: 'Loading...',
          lastModified: '',
        };
      });

      setRules(parsed);

      // Default selected object to the one with most rules
      if (parsed.length > 0) {
        const counts = new Map<string, number>();
        for (const r of parsed) {
          counts.set(r.objectName, (counts.get(r.objectName) ?? 0) + 1);
        }
        let maxObj = '';
        let maxCount = 0;
        counts.forEach((count, obj) => {
          if (count > maxCount) {
            maxCount = count;
            maxObj = obj;
          }
        });
        setSelectedObject(maxObj);
        if (!simulatorObject) setSimulatorObject(maxObj);
      }

      // Fetch full metadata (including errorConditionFormula) in batches of 10
      const BATCH_SIZE = 10;
      for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
        const batch = parsed.slice(i, i + BATCH_SIZE);
        const details = await Promise.all(
          batch.map((rule) =>
            sfRequest<ValidationRuleDetailResponse>(
              `/services/data/v62.0/tooling/sobjects/ValidationRule/${rule.id}`,
            ).catch(() => null),
          ),
        );

        setRules((prev) =>
          prev.map((rule) => {
            const detail = details.find(
              (d) => d !== null && d.Id === rule.id,
            );
            if (detail?.Metadata) {
              const formula = detail.Metadata.errorConditionFormula ?? '';
              return {
                ...rule,
                formula,
                description: detail.Metadata.description ?? rule.description,
                englishDescription: parseFormulaToEnglish(formula),
              };
            }
            return rule;
          }),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch validation rules';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [simulatorObject]);

  useEffect(() => {
    fetchValidationRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────

  const toggleRuleExpanded = useCallback((ruleId: string) => {
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) {
        next.delete(ruleId);
      } else {
        next.add(ruleId);
      }
      return next;
    });
  }, []);

  const runSimulator = useCallback(() => {
    const objectRules = rules.filter((r) => r.objectName === simulatorObject && r.active);
    const results: SimulatorResult[] = objectRules.map((rule) => {
      const fires = evaluateFormula(rule.formula, simulatorFieldValues);
      return {
        ruleName: rule.ruleName,
        passed: !fires, // Rule fires = validation FAILS
        errorMessage: rule.errorMessage,
        formula: rule.formula,
      };
    });
    setSimulatorResults(results);
  }, [rules, simulatorObject, simulatorFieldValues]);

  const handleSimulatorFieldChange = useCallback((fieldName: string, value: string) => {
    setSimulatorFieldValues((prev) => ({ ...prev, [fieldName]: value }));
  }, []);

  const handleSimulatorObjectChange = useCallback((obj: string) => {
    setSimulatorObject(obj);
    setSimulatorFieldValues({});
    setSimulatorResults(null);
  }, []);

  // ── Cross-Object table columns ─────────────────────────────────────────

  const crossObjectColumns = useMemo<ColumnDef<ObjectSummary, unknown>[]>(
    () => [
      {
        accessorKey: 'objectName',
        header: 'Object',
        cell: ({ getValue }) => (
          <span className="font-medium text-surface-800 dark:text-surface-200">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: 'ruleCount',
        header: '# Validation Rules',
        cell: ({ getValue }) => (
          <span className="font-mono text-sm">{getValue<number>()}</span>
        ),
      },
      {
        accessorKey: 'activeCount',
        header: '# Active',
        cell: ({ getValue }) => (
          <StatusBadge label={String(getValue<number>())} variant="success" />
        ),
      },
      {
        accessorKey: 'formulaFieldCount',
        header: '# Formula Fields',
        cell: ({ getValue }) => (
          <span className="font-mono text-sm">{getValue<number>()}</span>
        ),
      },
    ],
    [],
  );

  // ── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingSpinner message="Fetching validation rules from Tooling API..." />;
  }

  if (error) {
    return (
      <ErrorAlert
        title="Failed to load validation rules"
        message={error}
        onRetry={fetchValidationRules}
      />
    );
  }

  const tabClasses = (tab: TabId) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      activeTab === tab
        ? 'bg-primary-600 text-white shadow-sm'
        : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800'
    }`;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary-100 dark:bg-primary-900/40">
            <CheckSquare className="w-6 h-6 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900 dark:text-surface-100">
              Validation Rule Explorer
            </h1>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              {rules.length} validation rules across {objectNames.length} objects
            </p>
          </div>
        </div>
        <button
          onClick={fetchValidationRules}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-300
                     hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-surface-200 dark:border-surface-700 pb-3">
        <button className={tabClasses('rules')} onClick={() => setActiveTab('rules')}>
          <span className="flex items-center gap-2">
            <CheckSquare className="w-4 h-4" />
            Rule List
          </span>
        </button>
        <button className={tabClasses('simulator')} onClick={() => setActiveTab('simulator')}>
          <span className="flex items-center gap-2">
            <Play className="w-4 h-4" />
            What Blocks Me?
          </span>
        </button>
        <button className={tabClasses('cross-object')} onClick={() => setActiveTab('cross-object')}>
          <span className="flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Cross-Object View
          </span>
        </button>
      </div>

      {/* ── Tab: Rule List ──────────────────────────────────────────────── */}
      {activeTab === 'rules' && (
        <div className="flex flex-col gap-4">
          {/* Controls row */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Object selector */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-surface-600 dark:text-surface-400">
                Object:
              </label>
              <select
                value={selectedObject}
                onChange={(e) => setSelectedObject(e.target.value)}
                className="px-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                <option value="">All Objects</option>
                {objectSummaries.map((s) => (
                  <option key={s.objectName} value={s.objectName}>
                    {s.objectName} ({s.ruleCount})
                  </option>
                ))}
              </select>
            </div>

            {/* Active filter */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-surface-600 dark:text-surface-400">
                Status:
              </label>
              <select
                value={activeFilter}
                onChange={(e) => setActiveFilter(e.target.value as 'all' | 'active' | 'inactive')}
                className="px-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                <option value="all">All</option>
                <option value="active">Active Only</option>
                <option value="inactive">Inactive Only</option>
              </select>
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
              <input
                type="text"
                placeholder="Search by field name, error message, or formula..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              />
            </div>
          </div>

          {/* Results count */}
          <p className="text-xs text-surface-400">
            Showing {filteredRules.length} of {rules.length} rules
          </p>

          {/* Rule cards */}
          {filteredRules.length === 0 ? (
            <div className="text-center py-12 text-surface-400">
              No validation rules match the current filters.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredRules.map((rule) => {
                const isExpanded = expandedRules.has(rule.id);
                return (
                  <div
                    key={rule.id}
                    className="border border-surface-200 dark:border-surface-700 rounded-xl
                               bg-white dark:bg-surface-900 overflow-hidden"
                  >
                    {/* Card header */}
                    <div className="flex items-start justify-between gap-4 p-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200 truncate">
                            {rule.ruleName}
                          </h3>
                          <StatusBadge
                            label={rule.active ? 'Active' : 'Inactive'}
                            variant={rule.active ? 'success' : 'neutral'}
                          />
                        </div>
                        <p className="text-xs text-surface-400 mb-2">{rule.objectName}</p>

                        {/* English description */}
                        <p className="text-sm text-surface-700 dark:text-surface-300 mb-2">
                          {rule.englishDescription}
                        </p>

                        {/* Error message */}
                        <div className="flex items-start gap-2 mt-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40">
                          <span className="text-xs font-medium text-red-600 dark:text-red-400 shrink-0 mt-px">
                            Error:
                          </span>
                          <span className="text-xs text-red-700 dark:text-red-300">
                            {rule.errorMessage || '(no error message)'}
                          </span>
                        </div>

                        {rule.errorDisplayField && (
                          <p className="text-xs text-surface-400 mt-1">
                            Displayed on field: <span className="font-mono">{rule.errorDisplayField}</span>
                          </p>
                        )}
                      </div>

                      {/* Expand/collapse button */}
                      <button
                        onClick={() => toggleRuleExpanded(rule.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg
                                   text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors shrink-0"
                      >
                        {isExpanded ? (
                          <>
                            <ChevronUp className="w-3 h-3" />
                            Hide Formula
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-3 h-3" />
                            Show Formula
                          </>
                        )}
                      </button>
                    </div>

                    {/* Raw formula (collapsible) */}
                    {isExpanded && (
                      <div className="border-t border-surface-200 dark:border-surface-700 p-4 bg-surface-50 dark:bg-surface-800/50">
                        <p className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-2">
                          Raw Formula
                        </p>
                        <pre className="text-xs font-mono text-surface-700 dark:text-surface-300 whitespace-pre-wrap break-words bg-surface-100 dark:bg-surface-800 rounded-lg p-3 overflow-auto max-h-48">
                          {rule.formula || '(empty)'}
                        </pre>
                        {rule.description && (
                          <div className="mt-3">
                            <p className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                              Description
                            </p>
                            <p className="text-xs text-surface-600 dark:text-surface-400">
                              {rule.description}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: What Blocks Me? Simulator ──────────────────────────────── */}
      {activeTab === 'simulator' && (
        <div className="flex flex-col gap-6">
          <div className="border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900 p-6">
            <h2 className="text-base font-semibold text-surface-800 dark:text-surface-200 mb-4">
              Validation Rule Simulator
            </h2>
            <p className="text-sm text-surface-500 dark:text-surface-400 mb-6">
              Select an object, fill in field values, and run the simulator to see which
              validation rules would block your record save.
            </p>

            {/* Object selector */}
            <div className="flex items-center gap-3 mb-6">
              <label className="text-sm font-medium text-surface-600 dark:text-surface-400">
                Object:
              </label>
              <select
                value={simulatorObject}
                onChange={(e) => handleSimulatorObjectChange(e.target.value)}
                className="px-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                <option value="">Select an object...</option>
                {objectNames.map((obj) => (
                  <option key={obj} value={obj}>
                    {obj}
                  </option>
                ))}
              </select>
            </div>

            {/* Field value inputs */}
            {simulatorObject && simulatorFields.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-3">
                  Field Values
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {simulatorFields.map((fieldName) => (
                    <div key={fieldName} className="flex flex-col gap-1">
                      <label className="text-xs font-medium text-surface-500 dark:text-surface-400 font-mono">
                        {fieldName}
                      </label>
                      <input
                        type="text"
                        value={simulatorFieldValues[fieldName] ?? ''}
                        onChange={(e) => handleSimulatorFieldChange(fieldName, e.target.value)}
                        placeholder="Enter value..."
                        className="px-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                                   bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                                   focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {simulatorObject && simulatorFields.length === 0 && (
              <p className="text-sm text-surface-400 mb-6">
                No active validation rules with parseable field references found for this object.
              </p>
            )}

            {/* Run button */}
            {simulatorObject && (
              <button
                onClick={runSimulator}
                className="flex items-center gap-2 px-5 py-2 text-sm font-medium rounded-lg
                           bg-primary-600 text-white hover:bg-primary-700 transition-colors shadow-sm"
              >
                <Play className="w-4 h-4" />
                Run Simulator
              </button>
            )}
          </div>

          {/* Simulator results */}
          {simulatorResults !== null && (
            <div className="border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900 p-6">
              <h2 className="text-base font-semibold text-surface-800 dark:text-surface-200 mb-4">
                Results
              </h2>
              {simulatorResults.length === 0 ? (
                <p className="text-sm text-surface-400">
                  No active validation rules found for this object.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {simulatorResults.map((result, idx) => (
                    <div
                      key={idx}
                      className={`flex items-start gap-3 p-3 rounded-lg border ${
                        result.passed
                          ? 'border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/20'
                          : 'border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20'
                      }`}
                    >
                      <StatusBadge
                        label={result.passed ? 'PASS' : 'FAIL'}
                        variant={result.passed ? 'success' : 'danger'}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-surface-800 dark:text-surface-200">
                          {result.ruleName}
                        </p>
                        {!result.passed && (
                          <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                            {result.errorMessage}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Summary */}
                  <div className="mt-3 pt-3 border-t border-surface-200 dark:border-surface-700 flex items-center gap-4">
                    <span className="text-sm text-surface-600 dark:text-surface-400">
                      {simulatorResults.filter((r) => r.passed).length} passed
                    </span>
                    <span className="text-sm text-surface-600 dark:text-surface-400">
                      {simulatorResults.filter((r) => !r.passed).length} failed
                    </span>
                    {simulatorResults.every((r) => r.passed) ? (
                      <span className="text-sm font-medium text-green-600 dark:text-green-400">
                        Record would save successfully
                      </span>
                    ) : (
                      <span className="text-sm font-medium text-red-600 dark:text-red-400">
                        Record save would be blocked
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Cross-Object View ──────────────────────────────────────── */}
      {activeTab === 'cross-object' && (
        <DataTable
          data={objectSummaries}
          columns={crossObjectColumns}
          title="Validation Rules by Object"
          searchable
          exportable
          exportFilename="validation-rules-cross-object"
          pageSize={25}
          onRowClick={(row) => {
            setSelectedObject(row.objectName);
            setActiveTab('rules');
          }}
        />
      )}
    </div>
  );
}
