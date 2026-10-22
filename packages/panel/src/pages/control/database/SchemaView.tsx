import { Card, CardHeader } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { CopyButton } from '@/components/ui/CopyButton';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { Tag } from '@/components/ui/Tag';

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
      <TableScroll className="rounded-card border border-line bg-surface">
        <Table>
          <THead>
            <tr>
              <Th>Column</Th>
              <Th>Type</Th>
              <Th>Constraints</Th>
              <Th>Default</Th>
            </tr>
          </THead>
          <tbody>
            {schema.columns.map((c) => (
              <Tr key={c.name} dense>
                <Td className="font-mono text-[13px]">{c.name}</Td>
                <Td className="font-mono text-[13px] text-muted">{c.type}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1.5">
                    {c.primaryKey && <Tag>PK</Tag>}
                    {c.notNull && <Tag>NOT NULL</Tag>}
                  </span>
                </Td>
                <Td className="font-mono text-[13px] text-muted">{c.defaultValue ?? '—'}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>

      <Card>
        <CardHeader title={`Indexes (${schema.indexes.length})`} />
        {schema.indexes.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No indexes on this table.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {schema.indexes.map((ix) => (
              <li key={ix.name} className="flex flex-wrap items-center gap-2 font-mono text-[13px]">
                <span className="font-bold text-fg">{ix.name}</span>
                {ix.unique && <Tag>UNIQUE</Tag>}
                <span className="text-muted">({ix.columns.join(', ')})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {schema.sql && (
        <Card>
          <CardHeader title="DDL" action={<CopyButton value={schema.sql} />} />
          <CodeBlock label="DDL">{schema.sql}</CodeBlock>
        </Card>
      )}
    </div>
  );
}
