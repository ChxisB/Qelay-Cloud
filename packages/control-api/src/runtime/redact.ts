/** Strips every value of a credential-looking variable from a message, as the tick's CLI does. */
export function redactor(
  env: Readonly<Record<string, string | undefined>>
): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => /SECRET|TOKEN|PASSWORD|DATABASE_URL|KEY/i.test(name) && value)
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((out, secret) => out.split(secret).join('***'), text);
}
