import { Card, CardHeader } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { CopyButton } from '@/components/ui/CopyButton';

export function S3EnvironmentCard({
  environment,
}: {
  environment: { ok: true; value: string } | { ok: false; errors: string[] };
}) {
  return (
    <Card>
      <CardHeader
        title="Server environment"
        sub="Credentials stay in memory and are copied or applied only when you request it."
        action={environment.ok ? <CopyButton value={environment.value} /> : undefined}
      />
      {environment.ok ? (
        <CodeBlock label="Server environment settings" className="whitespace-pre-wrap break-all">
          {environment.value
            .replace(/^S3_ACCESS_KEY_ID=.*$/m, 'S3_ACCESS_KEY_ID="••••••••"')
            .replace(/^S3_SECRET_ACCESS_KEY=.*$/m, 'S3_SECRET_ACCESS_KEY="••••••••"')
            .replace(/^S3_SESSION_TOKEN=.*$/m, 'S3_SESSION_TOKEN="••••••••"')}
        </CodeBlock>
      ) : (
        <ul
          className="m-0 space-y-1 pl-0 text-[13px] font-semibold text-danger"
          aria-label="Configuration errors"
        >
          {environment.errors.map((error) => (
            <li key={error}>• {error}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
