import { useState, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
} from '@tanstack/react-table';
import { ArrowUpDown, ArrowUp, ArrowDown, Download, Columns3, Search } from 'lucide-react';
import { saveAs } from 'file-saver';

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  title?: string;
  searchable?: boolean;
  exportable?: boolean;
  exportFilename?: string;
  pageSize?: number;
  onRowClick?: (row: T) => void;
}

export default function DataTable<T>({
  data,
  columns,
  title,
  searchable = true,
  exportable = true,
  exportFilename = 'export',
  pageSize = 25,
  onRowClick,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const exportCsv = useMemo(() => () => {
    const headers = table.getVisibleFlatColumns().map((c) => c.id);
    const rows = table.getFilteredRowModel().rows.map((row) =>
      headers.map((h) => {
        const val = row.getValue(h);
        const str = val == null ? '' : String(val);
        return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      })
    );
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `${exportFilename}.csv`);
  }, [table, exportFilename]);

  return (
    <div className="border border-surface-200 dark:border-surface-700 rounded-xl overflow-hidden bg-white dark:bg-surface-900">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 p-3 border-b border-surface-200 dark:border-surface-700">
        <div className="flex items-center gap-3">
          {title && <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">{title}</h3>}
          <span className="text-xs text-surface-400">
            {table.getFilteredRowModel().rows.length} records
          </span>
        </div>
        <div className="flex items-center gap-2">
          {searchable && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
              <input
                type="text"
                placeholder="Search..."
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-sm rounded-lg border border-surface-200 dark:border-surface-600
                           bg-surface-50 dark:bg-surface-800 text-surface-800 dark:text-surface-200
                           focus:outline-none focus:ring-2 focus:ring-primary-500/40 w-48"
              />
            </div>
          )}
          <div className="relative">
            <button
              onClick={() => setShowColumnPicker(!showColumnPicker)}
              className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800"
              title="Toggle columns"
            >
              <Columns3 className="w-4 h-4" />
            </button>
            {showColumnPicker && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-600 rounded-lg shadow-lg p-2 min-w-[180px]">
                {table.getAllLeafColumns().map((column) => (
                  <label key={column.id} className="flex items-center gap-2 px-2 py-1 text-sm text-surface-700 dark:text-surface-300 cursor-pointer hover:bg-surface-50 dark:hover:bg-surface-700 rounded">
                    <input
                      type="checkbox"
                      checked={column.getIsVisible()}
                      onChange={column.getToggleVisibilityHandler()}
                      className="rounded"
                    />
                    {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
                  </label>
                ))}
              </div>
            )}
          </div>
          {exportable && (
            <button
              onClick={exportCsv}
              className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800"
              title="Export CSV"
            >
              <Download className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-surface-200 dark:border-surface-700">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-4 py-2.5 text-left text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider cursor-pointer select-none hover:bg-surface-50 dark:hover:bg-surface-800"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-1">
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && (
                        header.column.getIsSorted() === 'asc' ? <ArrowUp className="w-3 h-3" /> :
                        header.column.getIsSorted() === 'desc' ? <ArrowDown className="w-3 h-3" /> :
                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                className={`border-b border-surface-100 dark:border-surface-800 transition-colors
                  ${onRowClick ? 'cursor-pointer hover:bg-primary-50 dark:hover:bg-primary-900/20' : 'hover:bg-surface-50 dark:hover:bg-surface-800/50'}`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2.5 text-surface-700 dark:text-surface-300">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-surface-200 dark:border-surface-700 text-sm">
          <span className="text-surface-500 dark:text-surface-400">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <div className="flex gap-1">
            <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}
              className="px-3 py-1 rounded-lg disabled:opacity-30 hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-600 dark:text-surface-400">
              Prev
            </button>
            <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}
              className="px-3 py-1 rounded-lg disabled:opacity-30 hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-600 dark:text-surface-400">
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
