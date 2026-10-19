import { SHARD_SECRET_VARIABLE } from '@qelay-cloud/store-postgres';

type Env = Readonly<Record<string, string | undefined>>;

/** The variables whose values are, or carry, a credential. */
const SECRET_VARIABLES = [
  'QCLOUD_DATABASE_URL',
  'QCLOUD_DATABASE_LISTEN_URL',
  'QCLOUD_TICK_SHARED_SECRET',
  'QCLOUD_WEBHOOK_KEY',
] as const;

const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

/** The strings in `env` that must never appear in a log line: whole values, and URL passwords. */
function secretsIn(env: Env): string[] {
  const secrets = new Set<string>();
  for (const name of [
    ...SECRET_VARIABLES,
    ...Object.keys(env).filter((n) => SHARD_SECRET_VARIABLE.test(n)),
  ]) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    secrets.add(value);
    try {
      const { password } = new URL(value);
      if (password !== '') {
        secrets.add(password);
        secrets.add(decodeURIComponent(password));
      }
    } catch {
      // Not a URL: the whole value is already listed.
    }
  }
  // Longest first, so a URL is replaced whole before its password is looked for inside it.
  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * Builds the function every line the CLI prints goes through. A driver error can repeat the
 * connection string it was given, so each secret in the environment is replaced by `***`, and so is
 * the user and password of any URL, whatever its source. Defence in depth: nothing here is
 * supposed to be printed with a credential in it.
 */
export function redactor(env: Env): (text: string) => string {
  const secrets = secretsIn(env);
  return (text) => {
    let safe = text;
    for (const secret of secrets) safe = safe.split(secret).join('***');
    return safe.replace(USERINFO, '$1***@');
  };
}
