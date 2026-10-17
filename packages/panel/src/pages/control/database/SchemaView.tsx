import { Card, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';

export function SchemaView({
  schema,
}: {
  schema: {
    table: string;
    columns: {
      name: string;
      type: string;
      notNull: boolean;
      defaultValue: string | null;
      primaryKey: boolean;
    }[];
    indexes: { name: string; unique: boolean; columns: string[] }[];
    sql: string | null;
    rowCount: number;
  };
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left eyebrow text-muted light:bg-surface-2">
              <th className="px-4 py-2.5 font-semibold">Column</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 font-semibold">Constraints</th>
              <th className="px-4 py-2.5 font-semibold">Default</th>
            </tr>
          </thead>
          <tbody>
            {schema.columns.map((c) => (
              <tr key={c.name} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-fg">{c.name}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted">{c.type}</td>
                <td className="px-4 py-2 text-xs">
                  {c.primaryKey && (
                    <span className="mr-1 rounded-md bg-selected px-1.5 py-0.5 text-[10px] font-semibold text-link">
                      PK
                    </span>
                  )}
                  {c.notNull && (
                    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                      NOT NULL
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-faint">{c.defaultValue ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card>
        <CardHeader title={`Indexes (${schema.indexes.length})`} />
        {schema.indexes.length === 0 ? (
          <p className="text-xs text-faint">No indexes on this table.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {schema.indexes.map((ix) => (
              <li key={ix.name} className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <span className="text-fg">{ix.name}</span>
                {ix.unique && (
                  <span className="rounded-md bg-selected px-1.5 py-0.5 text-[10px] font-semibold text-link">
                    UNIQUE
                  </span>
                )}
                <span className="text-faint">({ix.columns.join(', ')})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {schema.sql && (
        <Card>
          <CardHeader title="DDL" action={<CopyButton value={schema.sql} />} />
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
            {schema.sql}
          </pre>
        </Card>
      )}
    </div>
  );
}
