import { useState, useEffect, useCallback, useMemo } from 'react';
import { Shield, Search, Users, RefreshCw, Download, Eye, GitCompare } from 'lucide-react';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorAlert from '@/components/ErrorAlert';
import Modal from '@/components/Modal';
import { useAppStore } from '@/services/store';
import { queryAll } from '@/services/salesforce';
import type { ColumnDef } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PermissionSetRecord {
  Id: string;
  Name: string;
  Label: string;
  Description: string | null;
}

interface ObjectPermissionRecord {
  SobjectType: string;
  PermissionsRead: boolean;
  PermissionsCreate: boolean;
  PermissionsEdit: boolean;
  PermissionsDelete: boolean;
}

interface PermissionSetAssignmentRecord {
  AssigneeId: string;
  PermissionSetId: string;
}

interface UserRecord {
  Id: string;
  Name: string;
  Profile?: { Name: string } | null;
  IsActive: boolean;
}

/** Aggregated permission level for a single object within a permission set. */
type PermissionLevel = 'full' | 'read-only' | 'none';

interface MatrixCell {
  objectName: string;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  level: PermissionLevel;
}

interface PermissionSetWithPerms {
  id: string;
  name: string;
  label: string;
  description: string | null;
  objectPerms: MatrixCell[];
  assigneeCount: number;
  hasOnlyInactiveUsers: boolean;
}

interface UserPermissionSummary {
  user: UserRecord;
  profileName: string;
  assignedSets: PermissionSetRecord[];
  effectivePerms: Map<string, MatrixCell>;
}

type ActiveTab = 'matrix' | 'user-lookup' | 'compare' | 'unused';

// ---------------------------------------------------------------------------
// SOQL Queries
// ---------------------------------------------------------------------------

const SOQL_PERMISSION_SETS =
  'SELECT Id, Name, Label, Description FROM PermissionSet WHERE IsCustom = true ORDER BY Label';

const SOQL_OBJECT_PERMISSIONS = (psId: string) =>
  `SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete FROM ObjectPermissions WHERE ParentId = '${psId}'`;

const SOQL_ASSIGNMENTS =
  'SELECT AssigneeId, PermissionSetId FROM PermissionSetAssignment';

const SOQL_ACTIVE_USERS =
  "SELECT Id, Name, Profile.Name, IsActive FROM User WHERE IsActive = true ORDER BY Name";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveLevel(cell: Omit<MatrixCell, 'level'>): PermissionLevel {
  if (cell.read && cell.create && cell.edit && cell.delete) return 'full';
  if (cell.read) return 'read-only';
  return 'none';
}

function levelColor(level: PermissionLevel): string {
  switch (level) {
    case 'full':
      return 'bg-green-500 dark:bg-green-600';
    case 'read-only':
      return 'bg-amber-400 dark:bg-amber-500';
    case 'none':
      return 'bg-surface-300 dark:bg-surface-600';
  }
}

function levelLabel(level: PermissionLevel): string {
  switch (level) {
    case 'full':
      return 'Full CRUD';
    case 'read-only':
      return 'Read Only';
    case 'none':
      return 'None';
  }
}

function levelVariant(level: PermissionLevel): 'success' | 'warning' | 'neutral' {
  switch (level) {
    case 'full':
      return 'success';
    case 'read-only':
      return 'warning';
    case 'none':
      return 'neutral';
  }
}

function exportCsv(filename: string, headers: string[], rows: string[][]) {
  const escape = (v: string) =>
    v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
  const csv = [
    headers.map(escape).join(','),
    ...rows.map((r) => r.map(escape).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function mergePerms(
  existing: MatrixCell | undefined,
  incoming: MatrixCell,
): MatrixCell {
  if (!existing) return incoming;
  const merged = {
    objectName: existing.objectName,
    read: existing.read || incoming.read,
    create: existing.create || incoming.create,
    edit: existing.edit || incoming.edit,
    delete: existing.delete || incoming.delete,
    level: 'none' as PermissionLevel,
  };
  merged.level = deriveLevel(merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PermissionMapper() {
  // ── Global state ──────────────────────────────────────────────────────
  const setCacheEntry = useAppStore((s) => s.setCacheEntry);
  const getCacheEntry = useAppStore((s) => s.getCacheEntry);

  // ── Local state ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('matrix');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Core data
  const [permissionSets, setPermissionSets] = useState<PermissionSetRecord[]>([]);
  const [assignments, setAssignments] = useState<PermissionSetAssignmentRecord[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [psPerms, setPsPerms] = useState<Map<string, MatrixCell[]>>(new Map());

  // Matrix
  const [expandedPsId, setExpandedPsId] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<{
    ps: PermissionSetRecord;
    cell: MatrixCell;
  } | null>(null);

  // User lookup
  const [userSearch, setUserSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserPermissionSummary | null>(null);
  const [userLoading, setUserLoading] = useState(false);

  // Compare
  const [compareMode, setCompareMode] = useState<'users' | 'permsets'>('permsets');
  const [compareLeft, setCompareLeft] = useState('');
  const [compareRight, setCompareRight] = useState('');
  const [compareResult, setCompareResult] = useState<{
    leftLabel: string;
    rightLabel: string;
    rows: {
      objectName: string;
      leftLevel: PermissionLevel;
      rightLevel: PermissionLevel;
      isDiff: boolean;
    }[];
  } | null>(null);

  // ── Collect all unique objects across loaded permission sets ────────
  const allObjects = useMemo(() => {
    const set = new Set<string>();
    psPerms.forEach((cells) => cells.forEach((c) => set.add(c.objectName)));
    return Array.from(set).sort();
  }, [psPerms]);

  // ── Enriched PS list ──────────────────────────────────────────────────
  const enrichedSets = useMemo<PermissionSetWithPerms[]>(() => {
    return permissionSets.map((ps) => {
      const objPerms = psPerms.get(ps.Id) ?? [];
      const psAssignments = assignments.filter((a) => a.PermissionSetId === ps.Id);
      const assigneeIds = new Set(psAssignments.map((a) => a.AssigneeId));
      const assignedUsers = users.filter((u) => assigneeIds.has(u.Id));
      const hasOnlyInactiveUsers =
        assignedUsers.length > 0 && assignedUsers.every((u) => !u.IsActive);

      return {
        id: ps.Id,
        name: ps.Name,
        label: ps.Label,
        description: ps.Description,
        objectPerms: objPerms,
        assigneeCount: psAssignments.length,
        hasOnlyInactiveUsers,
      };
    });
  }, [permissionSets, psPerms, assignments, users]);

  // ── Unused permission sets ────────────────────────────────────────────
  const unusedSets = useMemo(() => {
    return enrichedSets.filter(
      (ps) => ps.assigneeCount === 0 || ps.hasOnlyInactiveUsers,
    );
  }, [enrichedSets]);

  // ── Data fetch ────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch permission sets, assignments, users in parallel
      const [psResult, assignResult, userResult] = await Promise.all([
        queryAll<PermissionSetRecord & { Id: string }>(SOQL_PERMISSION_SETS),
        queryAll<PermissionSetAssignmentRecord & { Id?: string }>(SOQL_ASSIGNMENTS),
        queryAll<UserRecord & { Id: string }>(SOQL_ACTIVE_USERS),
      ]);

      let psList = psResult.records;

      // Fallback: if IsCustom filter returns nothing, try without it
      if (psList.length === 0) {
        const fallbackResult = await queryAll<PermissionSetRecord & { Id: string }>(
          'SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false LIMIT 100',
        );
        psList = fallbackResult.records.map((r) => ({
          ...r,
          Description: r.Description ?? null,
        }));
      }

      const assignList = assignResult.records;
      const userList = userResult.records;

      setPermissionSets(psList);
      setAssignments(assignList);
      setUsers(userList);

      // Cache raw lists
      setCacheEntry('permission-mapper:ps', psList);
      setCacheEntry('permission-mapper:assignments', assignList);
      setCacheEntry('permission-mapper:users', userList);

      // Fetch object permissions for each PS (batched)
      const permsMap = new Map<string, MatrixCell[]>();
      const batchSize = 5;

      for (let i = 0; i < psList.length; i += batchSize) {
        const batch = psList.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((ps) =>
            queryAll<ObjectPermissionRecord & { Id?: string }>(
              SOQL_OBJECT_PERMISSIONS(ps.Id),
            ).then((r) => ({ psId: ps.Id, records: r.records })),
          ),
        );

        for (const { psId, records } of results) {
          const cells: MatrixCell[] = records.map((r) => {
            const partial = {
              objectName: r.SobjectType,
              read: r.PermissionsRead,
              create: r.PermissionsCreate,
              edit: r.PermissionsEdit,
              delete: r.PermissionsDelete,
            };
            return { ...partial, level: deriveLevel(partial) };
          });
          permsMap.set(psId, cells);
        }
      }

      setPsPerms(permsMap);
      setCacheEntry('permission-mapper:perms', Object.fromEntries(permsMap));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load permission data');
    } finally {
      setLoading(false);
    }
  }, [setCacheEntry]);

  // Initial load
  useEffect(() => {
    // Try cache first
    const cachedPs = getCacheEntry('permission-mapper:ps');
    if (cachedPs) {
      setPermissionSets(cachedPs.data as PermissionSetRecord[]);
      const cachedAssign = getCacheEntry('permission-mapper:assignments');
      if (cachedAssign) setAssignments(cachedAssign.data as PermissionSetAssignmentRecord[]);
      const cachedUsers = getCacheEntry('permission-mapper:users');
      if (cachedUsers) setUsers(cachedUsers.data as UserRecord[]);
      const cachedPerms = getCacheEntry('permission-mapper:perms');
      if (cachedPerms) {
        const entries = Object.entries(cachedPerms.data as Record<string, MatrixCell[]>);
        setPsPerms(new Map(entries));
      }
      return;
    }
    fetchData();
  }, [fetchData, getCacheEntry]);

  // ── User lookup handler ───────────────────────────────────────────────
  const handleUserLookup = useCallback(
    async (userId: string) => {
      const user = users.find((u) => u.Id === userId);
      if (!user) return;

      setUserLoading(true);
      try {
        const userAssignments = assignments.filter((a) => a.AssigneeId === userId);
        const assignedPsIds = new Set(userAssignments.map((a) => a.PermissionSetId));
        const assignedSets = permissionSets.filter((ps) => assignedPsIds.has(ps.Id));

        // Merge effective permissions from all assigned PSs
        const effectivePerms = new Map<string, MatrixCell>();
        for (const psId of assignedPsIds) {
          const cells = psPerms.get(psId) ?? [];
          for (const cell of cells) {
            effectivePerms.set(
              cell.objectName,
              mergePerms(effectivePerms.get(cell.objectName), cell),
            );
          }
        }

        setSelectedUser({
          user,
          profileName: user.Profile?.Name ?? 'Unknown',
          assignedSets,
          effectivePerms,
        });
      } finally {
        setUserLoading(false);
      }
    },
    [users, assignments, permissionSets, psPerms],
  );

  // ── Compare handler ───────────────────────────────────────────────────
  const handleCompare = useCallback(async () => {
    if (!compareLeft || !compareRight) return;

    setLoading(true);
    setError(null);

    try {
      let leftPerms: Map<string, MatrixCell>;
      let rightPerms: Map<string, MatrixCell>;
      let leftLabel: string;
      let rightLabel: string;

      // Helper: ensure ObjectPermissions are loaded for a given permission set ID
      const ensurePermsLoaded = async (psId: string): Promise<MatrixCell[]> => {
        const existing = psPerms.get(psId);
        if (existing) return existing;

        // Fetch ObjectPermissions for this PS on demand
        try {
          const result = await queryAll<ObjectPermissionRecord & { Id?: string }>(
            SOQL_OBJECT_PERMISSIONS(psId),
          );
          const cells: MatrixCell[] = result.records.map((r) => {
            const partial = {
              objectName: r.SobjectType,
              read: r.PermissionsRead,
              create: r.PermissionsCreate,
              edit: r.PermissionsEdit,
              delete: r.PermissionsDelete,
            };
            return { ...partial, level: deriveLevel(partial) };
          });
          // Update the shared map so subsequent lookups find it
          setPsPerms((prev) => {
            const next = new Map(prev);
            next.set(psId, cells);
            return next;
          });
          return cells;
        } catch {
          return [];
        }
      };

      if (compareMode === 'permsets') {
        const [leftCells, rightCells] = await Promise.all([
          ensurePermsLoaded(compareLeft),
          ensurePermsLoaded(compareRight),
        ]);
        leftPerms = new Map(leftCells.map((c) => [c.objectName, c]));
        rightPerms = new Map(rightCells.map((c) => [c.objectName, c]));
        const leftPs = permissionSets.find((ps) => ps.Id === compareLeft);
        const rightPs = permissionSets.find((ps) => ps.Id === compareRight);
        leftLabel = leftPs?.Label ?? compareLeft;
        rightLabel = rightPs?.Label ?? compareRight;
      } else {
        // Compare users: build effective perms for each
        leftPerms = new Map<string, MatrixCell>();
        rightPerms = new Map<string, MatrixCell>();

        const leftAssignments = assignments.filter((a) => a.AssigneeId === compareLeft);
        const rightAssignments = assignments.filter((a) => a.AssigneeId === compareRight);

        // Fetch all missing permission data in parallel
        const allPsIds = new Set([
          ...leftAssignments.map((a) => a.PermissionSetId),
          ...rightAssignments.map((a) => a.PermissionSetId),
        ]);
        const fetchPromises = Array.from(allPsIds).map((psId) => ensurePermsLoaded(psId));
        const fetchedResults = await Promise.all(fetchPromises);

        // Build a local lookup from the fetched results
        const localPermsMap = new Map<string, MatrixCell[]>();
        const psIdArray = Array.from(allPsIds);
        psIdArray.forEach((psId, idx) => {
          localPermsMap.set(psId, fetchedResults[idx]);
        });

        for (const a of leftAssignments) {
          for (const cell of localPermsMap.get(a.PermissionSetId) ?? []) {
            leftPerms.set(cell.objectName, mergePerms(leftPerms.get(cell.objectName), cell));
          }
        }
        for (const a of rightAssignments) {
          for (const cell of localPermsMap.get(a.PermissionSetId) ?? []) {
            rightPerms.set(cell.objectName, mergePerms(rightPerms.get(cell.objectName), cell));
          }
        }

        const leftUser = users.find((u) => u.Id === compareLeft);
        const rightUser = users.find((u) => u.Id === compareRight);
        leftLabel = leftUser?.Name ?? compareLeft;
        rightLabel = rightUser?.Name ?? compareRight;
      }

      const allObjs = new Set([...leftPerms.keys(), ...rightPerms.keys()]);
      const rows = Array.from(allObjs)
        .sort()
        .map((obj) => {
          const ll = leftPerms.get(obj)?.level ?? 'none';
          const rl = rightPerms.get(obj)?.level ?? 'none';
          return { objectName: obj, leftLevel: ll, rightLevel: rl, isDiff: ll !== rl };
        });

      setCompareResult({ leftLabel, rightLabel, rows });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compare permissions');
    } finally {
      setLoading(false);
    }
  }, [compareLeft, compareRight, compareMode, psPerms, permissionSets, assignments, users]);

  // ── Export handlers ───────────────────────────────────────────────────
  const handleExportMatrix = useCallback(() => {
    const headers = ['Permission Set', 'Object', 'Read', 'Create', 'Edit', 'Delete', 'Level'];
    const rows: string[][] = [];
    for (const ps of enrichedSets) {
      for (const cell of ps.objectPerms) {
        rows.push([
          ps.label,
          cell.objectName,
          cell.read ? 'Yes' : 'No',
          cell.create ? 'Yes' : 'No',
          cell.edit ? 'Yes' : 'No',
          cell.delete ? 'Yes' : 'No',
          levelLabel(cell.level),
        ]);
      }
    }
    exportCsv('permission-matrix', headers, rows);
  }, [enrichedSets]);

  const handleExportUserMappings = useCallback(() => {
    const headers = ['User', 'Profile', 'Permission Set'];
    const rows: string[][] = [];
    for (const user of users) {
      const userAssigns = assignments.filter((a) => a.AssigneeId === user.Id);
      if (userAssigns.length === 0) {
        rows.push([user.Name, user.Profile?.Name ?? '', '(none)']);
      } else {
        for (const a of userAssigns) {
          const ps = permissionSets.find((p) => p.Id === a.PermissionSetId);
          rows.push([user.Name, user.Profile?.Name ?? '', ps?.Label ?? a.PermissionSetId]);
        }
      }
    }
    exportCsv('user-permission-mappings', headers, rows);
  }, [users, assignments, permissionSets]);

  // ── Unused PS table columns ───────────────────────────────────────────
  const unusedColumns = useMemo<ColumnDef<PermissionSetWithPerms, unknown>[]>(
    () => [
      {
        accessorKey: 'label',
        header: 'Permission Set',
        cell: ({ getValue }) => (
          <span className="font-medium text-surface-800 dark:text-surface-200">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: 'name',
        header: 'API Name',
        cell: ({ getValue }) => (
          <code className="text-xs bg-surface-100 dark:bg-surface-800 px-1.5 py-0.5 rounded">
            {getValue<string>()}
          </code>
        ),
      },
      {
        accessorKey: 'assigneeCount',
        header: 'Assignments',
        cell: ({ getValue }) => {
          const count = getValue<number>();
          return (
            <StatusBadge
              label={count === 0 ? 'No assignments' : `${count} (inactive only)`}
              variant={count === 0 ? 'danger' : 'warning'}
            />
          );
        },
      },
      {
        accessorKey: 'description',
        header: 'Description',
        cell: ({ getValue }) => (
          <span className="text-surface-500 dark:text-surface-400 text-xs line-clamp-1">
            {getValue<string | null>() ?? '--'}
          </span>
        ),
      },
    ],
    [],
  );

  // ── Filtered users for search ─────────────────────────────────────────
  const filteredUsers = useMemo(() => {
    if (!userSearch.trim()) return [];
    const term = userSearch.toLowerCase();
    return users.filter((u) => u.Name.toLowerCase().includes(term)).slice(0, 20);
  }, [users, userSearch]);

  // ── Tab buttons ───────────────────────────────────────────────────────
  const tabs: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
    { id: 'matrix', label: 'Matrix View', icon: <Shield className="w-4 h-4" /> },
    { id: 'user-lookup', label: 'User Lookup', icon: <Search className="w-4 h-4" /> },
    { id: 'compare', label: 'Compare', icon: <GitCompare className="w-4 h-4" /> },
    { id: 'unused', label: 'Unused PSs', icon: <Users className="w-4 h-4" /> },
  ];

  // ── Loading / error states ────────────────────────────────────────────
  if (loading && permissionSets.length === 0) {
    return <LoadingSpinner message="Loading permission sets and assignments..." />;
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/40">
            <Shield className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-surface-900 dark:text-white">
              Permission Set Entitlement Mapper
            </h1>
            <p className="text-sm text-surface-500 dark:text-surface-400">
              Map, compare, and audit custom permission set entitlements across your org.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportMatrix}
            disabled={enrichedSets.length === 0}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg
                       border border-surface-200 dark:border-surface-600
                       text-surface-600 dark:text-surface-300
                       hover:bg-surface-50 dark:hover:bg-surface-800
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export matrix as CSV"
          >
            <Download className="w-4 h-4" />
            Matrix
          </button>
          <button
            onClick={handleExportUserMappings}
            disabled={users.length === 0}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg
                       border border-surface-200 dark:border-surface-600
                       text-surface-600 dark:text-surface-300
                       hover:bg-surface-50 dark:hover:bg-surface-800
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export user mappings as CSV"
          >
            <Download className="w-4 h-4" />
            Users
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg
                       bg-indigo-600 text-white hover:bg-indigo-700
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <ErrorAlert message={error} onRetry={fetchData} />
      )}

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4">
        {[
          {
            label: 'Custom Permission Sets',
            value: permissionSets.length,
            variant: 'info' as const,
          },
          {
            label: 'Active Users',
            value: users.length,
            variant: 'success' as const,
          },
          {
            label: 'Total Assignments',
            value: assignments.length,
            variant: 'neutral' as const,
          },
          {
            label: 'Unused / Inactive-Only',
            value: unusedSets.length,
            variant: unusedSets.length > 0 ? ('warning' as const) : ('success' as const),
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="flex flex-col gap-1 p-4 rounded-xl border border-surface-200 dark:border-surface-700
                       bg-white dark:bg-surface-900"
          >
            <span className="text-xs text-surface-500 dark:text-surface-400">{stat.label}</span>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold text-surface-800 dark:text-surface-100">
                {stat.value}
              </span>
              <StatusBadge label={stat.variant === 'warning' ? 'Attention' : 'OK'} variant={stat.variant} />
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 rounded-xl bg-surface-100 dark:bg-surface-800 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors
              ${
                activeTab === tab.id
                  ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                  : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
              }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ──────────────────────────────────────────────────── */}

      {/* MATRIX VIEW */}
      {activeTab === 'matrix' && (
        <div className="border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900 overflow-hidden">
          {enrichedSets.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-surface-400">
              No custom permission sets found. Click Refresh to load data.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-200 dark:border-surface-700">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider sticky left-0 bg-white dark:bg-surface-900 z-10 min-w-[240px]">
                      Permission Set
                    </th>
                    {allObjects.map((obj) => (
                      <th
                        key={obj}
                        className="px-2 py-3 text-center text-[10px] font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider whitespace-nowrap"
                      >
                        <span className="writing-mode-vertical inline-block max-w-[80px] truncate" title={obj}>
                          {obj}
                        </span>
                      </th>
                    ))}
                    <th className="px-4 py-3 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
                      Assignments
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {enrichedSets.map((ps) => {
                    const objMap = new Map(ps.objectPerms.map((c) => [c.objectName, c]));
                    return (
                      <tr
                        key={ps.id}
                        className="border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors"
                      >
                        <td className="px-4 py-2.5 sticky left-0 bg-white dark:bg-surface-900 z-10">
                          <button
                            onClick={() =>
                              setExpandedPsId(expandedPsId === ps.id ? null : ps.id)
                            }
                            className="flex items-center gap-2 group text-left"
                          >
                            <Eye className="w-3.5 h-3.5 text-surface-400 group-hover:text-indigo-500 transition-colors" />
                            <div>
                              <div className="font-medium text-surface-800 dark:text-surface-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                                {ps.label}
                              </div>
                              <div className="text-[11px] text-surface-400">{ps.name}</div>
                            </div>
                          </button>
                        </td>
                        {allObjects.map((obj) => {
                          const cell = objMap.get(obj);
                          const level = cell?.level ?? 'none';
                          return (
                            <td key={obj} className="px-2 py-2.5 text-center">
                              <button
                                onClick={() => {
                                  if (cell) {
                                    const psRecord = permissionSets.find((p) => p.Id === ps.id);
                                    if (psRecord) setSelectedCell({ ps: psRecord, cell });
                                  }
                                }}
                                className={`inline-block w-5 h-5 rounded-md transition-transform hover:scale-125 ${levelColor(level)}`}
                                title={`${obj}: ${levelLabel(level)}`}
                              />
                            </td>
                          );
                        })}
                        <td className="px-4 py-2.5 text-center">
                          <StatusBadge
                            label={String(ps.assigneeCount)}
                            variant={
                              ps.assigneeCount === 0
                                ? 'danger'
                                : ps.hasOnlyInactiveUsers
                                  ? 'warning'
                                  : 'success'
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Legend */}
          <div className="flex items-center gap-6 px-4 py-3 border-t border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50">
            <span className="text-xs font-medium text-surface-500 dark:text-surface-400">Legend:</span>
            {(['full', 'read-only', 'none'] as PermissionLevel[]).map((level) => (
              <div key={level} className="flex items-center gap-1.5">
                <span className={`inline-block w-3.5 h-3.5 rounded ${levelColor(level)}`} />
                <span className="text-xs text-surface-600 dark:text-surface-300">
                  {levelLabel(level)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* USER LOOKUP */}
      {activeTab === 'user-lookup' && (
        <div className="flex flex-col gap-4">
          {/* Search box */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
            <input
              type="text"
              placeholder="Search user by name..."
              value={userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setSelectedUser(null);
              }}
              className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl
                         border border-surface-200 dark:border-surface-600
                         bg-white dark:bg-surface-900
                         text-surface-800 dark:text-surface-200
                         focus:outline-none focus:ring-2 focus:ring-indigo-500/40
                         placeholder:text-surface-400"
            />
          </div>

          {/* Search results */}
          {filteredUsers.length > 0 && !selectedUser && (
            <div className="border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900 overflow-hidden max-w-md">
              {filteredUsers.map((u) => (
                <button
                  key={u.Id}
                  onClick={() => handleUserLookup(u.Id)}
                  className="flex items-center justify-between w-full px-4 py-3 text-left
                             hover:bg-surface-50 dark:hover:bg-surface-800
                             border-b border-surface-100 dark:border-surface-800 last:border-b-0
                             transition-colors"
                >
                  <div>
                    <div className="font-medium text-surface-800 dark:text-surface-200 text-sm">
                      {u.Name}
                    </div>
                    <div className="text-xs text-surface-400">{u.Profile?.Name ?? 'No Profile'}</div>
                  </div>
                  <Eye className="w-4 h-4 text-surface-400" />
                </button>
              ))}
            </div>
          )}

          {/* User detail */}
          {userLoading && <LoadingSpinner message="Loading user permissions..." />}

          {selectedUser && !userLoading && (
            <div className="flex flex-col gap-4">
              {/* User info card */}
              <div className="border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900 p-5">
                <div className="flex items-center gap-4 mb-4">
                  <div className="flex items-center justify-center w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-900/40">
                    <Users className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-surface-900 dark:text-white">
                      {selectedUser.user.Name}
                    </h3>
                    <p className="text-sm text-surface-500 dark:text-surface-400">
                      Profile: <span className="font-medium">{selectedUser.profileName}</span>
                    </p>
                  </div>
                </div>

                {/* Assigned permission sets */}
                <div className="mb-4">
                  <h4 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">
                    Assigned Permission Sets ({selectedUser.assignedSets.length})
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {selectedUser.assignedSets.length === 0 ? (
                      <span className="text-sm text-surface-400">No custom permission sets assigned</span>
                    ) : (
                      selectedUser.assignedSets.map((ps) => (
                        <StatusBadge key={ps.Id} label={ps.Label} variant="info" />
                      ))
                    )}
                  </div>
                </div>

                {/* Effective permissions table */}
                <h4 className="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-2">
                  Effective Object Permissions
                </h4>
                <div className="overflow-x-auto border border-surface-200 dark:border-surface-700 rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800">
                        <th className="px-4 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                          Object
                        </th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                          Read
                        </th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                          Create
                        </th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                          Edit
                        </th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                          Delete
                        </th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                          Level
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(selectedUser.effectivePerms.entries())
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([objName, cell]) => (
                          <tr
                            key={objName}
                            className="border-b border-surface-100 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50"
                          >
                            <td className="px-4 py-2 font-medium text-surface-700 dark:text-surface-300">
                              {objName}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <CrudIndicator enabled={cell.read} />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <CrudIndicator enabled={cell.create} />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <CrudIndicator enabled={cell.edit} />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <CrudIndicator enabled={cell.delete} />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <StatusBadge label={levelLabel(cell.level)} variant={levelVariant(cell.level)} />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* COMPARE VIEW */}
      {activeTab === 'compare' && (
        <div className="flex flex-col gap-4">
          {/* Mode toggle + selectors */}
          <div className="flex flex-col gap-3 p-5 border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900">
            <div className="flex items-center gap-4 mb-2">
              <span className="text-sm font-medium text-surface-700 dark:text-surface-300">Compare:</span>
              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface-100 dark:bg-surface-800">
                <button
                  onClick={() => {
                    setCompareMode('permsets');
                    setCompareLeft('');
                    setCompareRight('');
                    setCompareResult(null);
                  }}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    compareMode === 'permsets'
                      ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                      : 'text-surface-500 dark:text-surface-400'
                  }`}
                >
                  Permission Sets
                </button>
                <button
                  onClick={() => {
                    setCompareMode('users');
                    setCompareLeft('');
                    setCompareRight('');
                    setCompareResult(null);
                  }}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    compareMode === 'users'
                      ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                      : 'text-surface-500 dark:text-surface-400'
                  }`}
                >
                  Users
                </button>
              </div>
            </div>

            <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                  {compareMode === 'permsets' ? 'Permission Set A' : 'User A'}
                </label>
                <select
                  value={compareLeft}
                  onChange={(e) => {
                    setCompareLeft(e.target.value);
                    setCompareResult(null);
                  }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                             bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                             focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                >
                  <option value="">Select...</option>
                  {compareMode === 'permsets'
                    ? permissionSets.map((ps) => (
                        <option key={ps.Id} value={ps.Id}>
                          {ps.Label}
                        </option>
                      ))
                    : users.map((u) => (
                        <option key={u.Id} value={u.Id}>
                          {u.Name}
                        </option>
                      ))}
                </select>
              </div>

              <div className="flex items-center justify-center pb-1">
                <GitCompare className="w-5 h-5 text-surface-400" />
              </div>

              <div>
                <label className="block text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
                  {compareMode === 'permsets' ? 'Permission Set B' : 'User B'}
                </label>
                <select
                  value={compareRight}
                  onChange={(e) => {
                    setCompareRight(e.target.value);
                    setCompareResult(null);
                  }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                             bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200
                             focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                >
                  <option value="">Select...</option>
                  {compareMode === 'permsets'
                    ? permissionSets.map((ps) => (
                        <option key={ps.Id} value={ps.Id}>
                          {ps.Label}
                        </option>
                      ))
                    : users.map((u) => (
                        <option key={u.Id} value={u.Id}>
                          {u.Name}
                        </option>
                      ))}
                </select>
              </div>
            </div>

            <button
              onClick={handleCompare}
              disabled={!compareLeft || !compareRight || compareLeft === compareRight}
              className="self-start flex items-center gap-2 px-4 py-2 mt-2 text-sm font-medium rounded-lg
                         bg-indigo-600 text-white hover:bg-indigo-700
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <GitCompare className="w-4 h-4" />
              Compare
            </button>
          </div>

          {/* Comparison results */}
          {compareResult && (
            <div className="border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900 overflow-hidden">
              <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50">
                <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
                  {compareResult.leftLabel} vs {compareResult.rightLabel}
                </h3>
                <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                  {compareResult.rows.filter((r) => r.isDiff).length} difference(s) found across{' '}
                  {compareResult.rows.length} object(s)
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-200 dark:border-surface-700">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                        Object
                      </th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                        {compareResult.leftLabel}
                      </th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                        {compareResult.rightLabel}
                      </th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareResult.rows.map((row) => (
                      <tr
                        key={row.objectName}
                        className={`border-b border-surface-100 dark:border-surface-800 ${
                          row.isDiff
                            ? 'bg-amber-50/50 dark:bg-amber-900/10'
                            : 'hover:bg-surface-50 dark:hover:bg-surface-800/50'
                        }`}
                      >
                        <td className="px-4 py-2 font-medium text-surface-700 dark:text-surface-300">
                          {row.objectName}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <StatusBadge label={levelLabel(row.leftLevel)} variant={levelVariant(row.leftLevel)} />
                        </td>
                        <td className="px-4 py-2 text-center">
                          <StatusBadge label={levelLabel(row.rightLevel)} variant={levelVariant(row.rightLevel)} />
                        </td>
                        <td className="px-4 py-2 text-center">
                          {row.isDiff ? (
                            <StatusBadge label="Different" variant="warning" />
                          ) : (
                            <StatusBadge label="Same" variant="neutral" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* UNUSED PERMISSION SETS */}
      {activeTab === 'unused' && (
        <div className="flex flex-col gap-4">
          {unusedSets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 border border-surface-200 dark:border-surface-700 rounded-xl bg-white dark:bg-surface-900">
              <Shield className="w-8 h-8 text-green-500" />
              <p className="text-sm text-surface-500 dark:text-surface-400">
                All custom permission sets are actively assigned. No cleanup needed.
              </p>
            </div>
          ) : (
            <DataTable
              data={unusedSets}
              columns={unusedColumns}
              title={`Unused / Inactive-Only Permission Sets (${unusedSets.length})`}
              exportFilename="unused-permission-sets"
              searchable
              exportable
            />
          )}
        </div>
      )}

      {/* ── Cell Detail Modal ────────────────────────────────────────────── */}
      <Modal
        open={selectedCell !== null}
        onClose={() => setSelectedCell(null)}
        title={
          selectedCell
            ? `${selectedCell.ps.Label} - ${selectedCell.cell.objectName}`
            : ''
        }
      >
        {selectedCell && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
                <span className="block text-xs text-surface-500 dark:text-surface-400 mb-1">
                  Permission Set
                </span>
                <span className="text-sm font-medium text-surface-800 dark:text-surface-200">
                  {selectedCell.ps.Label}
                </span>
              </div>
              <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
                <span className="block text-xs text-surface-500 dark:text-surface-400 mb-1">
                  Object
                </span>
                <span className="text-sm font-medium text-surface-800 dark:text-surface-200">
                  {selectedCell.cell.objectName}
                </span>
              </div>
            </div>

            <div className="border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-50 dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700">
                    <th className="px-4 py-2 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                      Permission
                    </th>
                    <th className="px-4 py-2 text-center text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase">
                      Granted
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Read', value: selectedCell.cell.read },
                    { label: 'Create', value: selectedCell.cell.create },
                    { label: 'Edit', value: selectedCell.cell.edit },
                    { label: 'Delete', value: selectedCell.cell.delete },
                  ].map((perm) => (
                    <tr
                      key={perm.label}
                      className="border-b border-surface-100 dark:border-surface-800"
                    >
                      <td className="px-4 py-2.5 text-surface-700 dark:text-surface-300">
                        {perm.label}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <CrudIndicator enabled={perm.value} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-surface-500 dark:text-surface-400">Overall Level:</span>
              <StatusBadge
                label={levelLabel(selectedCell.cell.level)}
                variant={levelVariant(selectedCell.cell.level)}
              />
            </div>

            {selectedCell.ps.Description && (
              <div className="p-3 rounded-lg bg-surface-50 dark:bg-surface-800">
                <span className="block text-xs text-surface-500 dark:text-surface-400 mb-1">
                  Description
                </span>
                <p className="text-sm text-surface-700 dark:text-surface-300">
                  {selectedCell.ps.Description}
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: CRUD Indicator
// ---------------------------------------------------------------------------

function CrudIndicator({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
        enabled
          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
          : 'bg-surface-100 text-surface-400 dark:bg-surface-700 dark:text-surface-500'
      }`}
    >
      {enabled ? '\u2713' : '\u2013'}
    </span>
  );
}
