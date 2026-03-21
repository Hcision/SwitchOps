// ── Tool Configuration ──────────────────────────────────────────────────────

export interface ToolConfig {
  id: string;
  number: number;
  name: string;
  shortName: string;
  icon: string; // lucide-react icon name
  category: 'metadata' | 'operations' | 'security' | 'sales' | 'loaders';
  description: string;
}

export const CATEGORIES: Record<ToolConfig['category'], string> = {
  metadata: 'Metadata Intelligence',
  operations: 'Operations & Monitoring',
  security: 'Access & Security',
  sales: 'Sales & Quoting',
  loaders: 'Data Loaders',
};

export const TOOLS: ToolConfig[] = [
  // ── Metadata Intelligence ───────────────────────────────────────────────
  {
    id: 'flow-graph',
    number: 1,
    name: 'Flow Graph',
    shortName: 'Flow Graph',
    icon: 'GitBranch',
    category: 'metadata',
    description: 'Visualize and analyze Salesforce automation flows as interactive graphs.',
  },
  {
    id: 'validation-explorer',
    number: 4,
    name: 'Validation Explorer',
    shortName: 'Validations',
    icon: 'CheckSquare',
    category: 'metadata',
    description: 'Browse, search, and analyze validation rules across all objects.',
  },
  {
    id: 'metadata-console',
    number: 6,
    name: 'Metadata Console',
    shortName: 'Metadata',
    icon: 'Database',
    category: 'metadata',
    description: 'Query and explore Salesforce metadata types and components.',
  },
  {
    id: 'deploy-analyzer',
    number: 7,
    name: 'Deploy Analyzer',
    shortName: 'Deploys',
    icon: 'GitPullRequest',
    category: 'metadata',
    description: 'Inspect deployment history, errors, and component dependencies.',
  },
  {
    id: 'field-lineage',
    number: 10,
    name: 'Field Lineage',
    shortName: 'Lineage',
    icon: 'Route',
    category: 'metadata',
    description: 'Trace field usage across flows, validation rules, and Apex code.',
  },

  // ── Operations & Monitoring ─────────────────────────────────────────────
  {
    id: 'sap-monitor',
    number: 2,
    name: 'SAP Monitor',
    shortName: 'SAP',
    icon: 'Activity',
    category: 'operations',
    description: 'Monitor SAP integration status, sync jobs, and error logs.',
  },
  {
    id: 'wo-tracker',
    number: 8,
    name: 'WO Tracker',
    shortName: 'Work Orders',
    icon: 'Truck',
    category: 'operations',
    description: 'Track field service work orders, assignments, and completion rates.',
  },
  {
    id: 'automation-switch',
    number: 9,
    name: 'Automation Switch',
    shortName: 'Automations',
    icon: 'ToggleLeft',
    category: 'operations',
    description: 'Bulk enable or disable automations, flows, and triggers.',
  },

  // ── Access & Security ───────────────────────────────────────────────────
  {
    id: 'permission-mapper',
    number: 3,
    name: 'Permission Mapper',
    shortName: 'Permissions',
    icon: 'Shield',
    category: 'security',
    description: 'Map and compare user permissions, profiles, and permission sets.',
  },

  // ── Sales & Quoting ─────────────────────────────────────────────────────
  {
    id: 'quote-checker',
    number: 5,
    name: 'Quote Checker',
    shortName: 'Quotes',
    icon: 'FileCheck',
    category: 'sales',
    description: 'Validate CPQ quotes, pricing rules, and approval configurations.',
  },

  // ── Data Loaders ────────────────────────────────────────────────────────
  {
    id: 'fsl-loader',
    number: 11,
    name: 'FSL Loader',
    shortName: 'FSL Load',
    icon: 'Upload',
    category: 'loaders',
    description: 'Bulk import and update Field Service Lightning data.',
  },
  {
    id: 'cpq-loader',
    number: 12,
    name: 'CPQ Loader',
    shortName: 'CPQ Load',
    icon: 'Package',
    category: 'loaders',
    description: 'Bulk import and update CPQ product, pricing, and bundle data.',
  },
];

/** Tools grouped by category (preserves insertion order). */
export function getToolsByCategory(): Record<ToolConfig['category'], ToolConfig[]> {
  const grouped = Object.keys(CATEGORIES).reduce(
    (acc, cat) => {
      acc[cat as ToolConfig['category']] = [];
      return acc;
    },
    {} as Record<ToolConfig['category'], ToolConfig[]>,
  );

  for (const tool of TOOLS) {
    grouped[tool.category].push(tool);
  }

  return grouped;
}

/** Lookup a single tool by its id. */
export function getToolById(id: string): ToolConfig | undefined {
  return TOOLS.find((t) => t.id === id);
}
