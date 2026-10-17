import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Glob } from 'bun';
import { GUARDED_ROOTS, violationsIn, withoutComments } from '../../scripts/transportBoundary';

describe('transport boundary rule', () => {
  test('a doc comment may name a broker, code may not', () => {
    const source = [
      '/** SQS and Pub/Sub differ here: see `gcp-pubsub`. */',
      "// import { SqsTransport } from '@qelay-cloud/transport-aws';",
      'const fine = 1;',
    ].join('\n');
    expect(violationsIn('x.ts', source)).toEqual([]);
    expect(withoutComments(source).split('\n')).toHaveLength(3);
  });

  test('an import of a broker package or SDK is refused', () => {
    for (const line of [
      "import { SqsTransport } from '@qelay-cloud/transport-aws';",
      "import { PubSub } from '@google-cloud/pubsub';",
      "import { SQSClient } from '@aws-sdk/client-sqs';",
      "const t = await import('../../transport-gcp/src');",
    ]) {
      expect(violationsIn('x.ts', line).length).toBeGreaterThan(0);
    }
  });

  test('a branch on a broker kind or class is refused, a string that merely contains it is not', () => {
    expect(violationsIn('x.ts', "if (kind === 'aws-sqs') run();")).toHaveLength(1);
    expect(violationsIn('x.ts', 'const t = new PubSubTransport({});')).toHaveLength(1);
    expect(violationsIn('x.ts', "const note = 'the aws-sqs-like path';")).toEqual([]);
  });

  test('a quote inside a comment does not hide the code after it', () => {
    const source = "// don't\nconst kind = 'gcp-pubsub';";
    expect(violationsIn('x.ts', source)).toHaveLength(1);
  });

  test('no package above the transports names a broker', async () => {
    const root = resolve(import.meta.dir, '../..');
    const found = [];
    for (const guarded of GUARDED_ROOTS) {
      for await (const path of new Glob('**/*.{ts,tsx}').scan({
        cwd: resolve(root, guarded),
        absolute: true,
      })) {
        found.push(...violationsIn(path, await Bun.file(path).text()));
      }
    }
    expect(found).toEqual([]);
  });
});
