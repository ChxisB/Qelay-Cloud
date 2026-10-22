import { SystemTabs } from '@/components/SystemTabs';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { SegmentedControl } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { StatCard } from '@/components/ui/StatCard';
import { Tag } from '@/components/ui/Tag';
import { cn } from '@/lib/cn';
import { formatBytes, formatNumber } from '@/lib/format';
import { FilterBar } from './FilterBar';
import { QueryRunner } from './QueryRunner';
import { ResultsTable } from './ResultsTable';
import { createDbDetailSelection } from './rowModel';
import { SchemaView } from './SchemaView';
import type { DatabaseController } from './useDatabaseController';

export function DatabaseShell({ db }: { db: DatabaseController }) {
  const {
    anyTruncated,
    colMeta,
    cycleSort,
    data,
    dbMissing,
    detail,
    editorRef,
    exportBusy,
    exportPage,
    exportTable,
    filter,
    info,
    infoError,
    msg,
    page,
    pageSize,
    queryThisTable,
    refetchInfo,
    refetchRows,
    refetchSchema,
    refetchTables,
    requestModal,
    rowsLoading,
    schema,
    schemaError,
    selectTable,
    selected,
    setDetailSelection,
    setFilter,
    setPage,
    setSql,
    setTab,
    sort,
    sql,
    tab,
    tables,
    tablesError,
    tablesLoading,
    visibleRowsError,
  } = db;

  return (
    <div
      data-database-background=""
      inert={detail ? true : undefined}
      aria-hidden={detail ? true : undefined}
    >
      <PageHeader
        title="Database"
        description="Look inside the server's database: its tables, the rows in them, and your own queries. You can read here but not change anything."
        actions={<Tag>read-only</Tag>}
      />
      <SystemTabs current="/database" />

      {tablesError && !dbMissing && (
        <OfflineBanner
          message={`Could not read the database — ${(tablesError as Error).message}`}
          onRetry={refetchTables}
        />
      )}
      {infoError && !dbMissing && (
        <OfflineBanner
          message={`Could not read database metadata — ${infoError.message}`}
          onRetry={refetchInfo}
        />
      )}

      {info && (
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <StatCard label="SQLite" value={info.sqliteVersion} compact />
          <StatCard label="On disk" value={formatBytes(info.fileSize + info.walSize)} compact />
          <StatCard label="Journal" value={info.journalMode.toUpperCase()} compact />
          <StatCard label="Tables" value={formatNumber(info.tables)} compact />
          <StatCard label="Indexes" value={formatNumber(info.indexes)} compact />
        </div>
      )}

      {dbMissing ? (
        <EmptyState title="No database yet" hint={(tablesError as Error).message} />
      ) : tablesLoading && tables.length === 0 ? (
        <LoadingState label="Reading database…" />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
          <Card padded={false} className="self-start overflow-hidden">
            <h2 className="m-0 border-b border-line px-4 py-4 text-lg font-bold text-fg">
              Tables ({tables.length})
            </h2>
            <ul className="m-0 max-h-[28rem] list-none overflow-y-auto p-0">
              {tables.map((t) => (
                <li key={t.name}>
                  <button
                    type="button"
                    onClick={() => selectTable(t.name)}
                    aria-pressed={selected === t.name}
                    className={cn(
                      'flex min-h-8 w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors',
                      'focus-visible:-outline-offset-3',
                      selected === t.name
                        ? 'bg-slate-tint font-bold text-fg'
                        : 'text-muted hover:bg-hover hover:text-fg'
                    )}
                  >
                    <span className="min-w-0 truncate font-mono text-[13px]">{t.name}</span>
                    <span className="shrink-0 text-[13px] text-muted tabular-nums">
                      {formatNumber(t.rows)}
                    </span>
                  </button>
                </li>
              ))}
              {tables.length === 0 && (
                <li className="px-4 py-4 text-center text-[13px] text-muted">No tables.</li>
              )}
            </ul>
          </Card>

          <div className="min-w-0 lg:col-span-3">
            {tables.length === 0 ? (
              <EmptyState title="No tables" hint="This database has no user tables yet." />
            ) : (
              <>
                {selected && (
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <h2
                      className="m-0 mr-auto min-w-0 truncate font-mono text-lg font-bold text-fg"
                      title={selected}
                    >
                      {selected}
                    </h2>
                    <Button size="sm" onClick={queryThisTable}>
                      Query
                    </Button>
                    <SegmentedControl
                      options={['data', 'schema'] as const}
                      value={tab}
                      onChange={setTab}
                      label="Table view"
                    />
                    {tab === 'data' && (
                      <>
                        <Button
                          size="sm"
                          disabled={!data || data.rows.length === 0}
                          title={
                            data
                              ? `Exports only the ${data.rows.length} rows on this page`
                              : undefined
                          }
                          onClick={exportPage}
                        >
                          Export this page{data ? ` (${data.rows.length})` : ''}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={exportBusy || !data || data.total === 0}
                          onClick={exportTable}
                        >
                          {exportBusy
                            ? 'Exporting…'
                            : `Export whole table${data ? ` (${formatNumber(data.total)})` : ''}`}
                        </Button>
                      </>
                    )}
                  </div>
                )}

                {tab === 'data' && selected && (
                  <FilterBar
                    key={selected}
                    columns={data?.columns ?? schema?.columns.map((c) => c.name) ?? []}
                    filter={filter}
                    onChange={(f) => {
                      setFilter(f);
                      setPage(0);
                      setDetailSelection(null);
                    }}
                  />
                )}

                {msg && <p className="m-0 mb-3 text-[13px] text-muted">{msg}</p>}

                {tab === 'schema' ? (
                  schemaError ? (
                    <EmptyState
                      title="Could not read schema"
                      hint={schemaError.message}
                      action={
                        <Button size="sm" onClick={refetchSchema}>
                          Retry
                        </Button>
                      }
                    />
                  ) : schema?.table === selected ? (
                    <SchemaView schema={schema} />
                  ) : (
                    <LoadingState label={`Reading schema of ${selected}…`} />
                  )
                ) : visibleRowsError ? (
                  <ErrorState error={visibleRowsError} onRetry={refetchRows} />
                ) : rowsLoading && !data ? (
                  <LoadingState label={`Reading ${selected}…`} />
                ) : !data ? (
                  <EmptyState
                    title="Select a table"
                    hint="Pick a table on the left to browse its rows."
                  />
                ) : data.total === 0 ? (
                  <EmptyState
                    title={filter ? 'No matching rows' : 'Empty table'}
                    hint={
                      filter ? 'No rows match the current filter.' : `"${data.table}" has no rows.`
                    }
                  />
                ) : (
                  <>
                    <ResultsTable
                      columns={data.columns}
                      rows={data.rows}
                      truncatedCells={data.truncatedCells}
                      colMeta={colMeta}
                      sort={sort}
                      onSort={cycleSort}
                      onRowClick={(i) => {
                        const selection = createDbDetailSelection(data, i);
                        if (selection && requestModal('database-row')) {
                          setDetailSelection(selection);
                        }
                      }}
                      dimmed={rowsLoading && !data}
                    />
                    {anyTruncated && (
                      <p className="m-0 mt-2 text-[13px] text-muted">
                        Cells over 2000 chars and BLOBs are abbreviated in the grid and CSV — use
                        the row's View action to read the full value.
                      </p>
                    )}
                    <Pagination
                      page={page}
                      pageSize={pageSize}
                      total={data.total}
                      onPageChange={(p) => {
                        setPage(p);
                        setDetailSelection(null);
                      }}
                      label="rows"
                    />
                  </>
                )}

                <QueryRunner sql={sql} setSql={setSql} editorRef={editorRef} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
