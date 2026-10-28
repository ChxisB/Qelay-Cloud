import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Glob } from 'bun';
import { INGEST_ROOT, ingestViolationsIn } from '../../scripts/ingestBoundary';

const FILE = `${INGEST_ROOT}/handler.ts`;

describe('ingest boundary rule', () => {
  test('its own files, Node, Bun, core and the store are allowed', () => {
    for (const line of [
      "import { readBody } from './body';",
      "import type { Env } from '../src/config';",
      "import { timingSafeEqual } from 'node:crypto';",
      "import { SQL } from 'bun';",
      "import { UnsupportedOptionError } from '@qelay-cloud/core';",
      "import { PostgresStore } from '@qelay-cloud/store-postgres';",
      "export { main } from './main';",
      "import './side';",
    ]) {
      expect(ingestViolationsIn(FILE, line), line).toEqual([]);
    }
  });

  test('a transport, the sender, the control plane, the SDK or a new dependency is refused', () => {
    for (const line of [
      "import { SqsTransport } from '@qelay-cloud/transport-aws';",
      "import { openTransport } from '@qelay-cloud/transports';",
      "import { deliver } from '@qelay-cloud/maintenance';",
      "import { createControlApi } from '@qelay-cloud/control-api';",
      "import { Qelay } from 'qelay-cloud';",
      "import { z } from 'zod';",
      "import { PubSub } from '@google-cloud/pubsub';",
      "const later = await import('some-http-client');",
      "const old = require('axios');",
      "import 'left-pad';",
    ]) {
      expect(ingestViolationsIn(FILE, line).length, line).toBeGreaterThan(0);
    }
  });

  test('a relative path that leaves the package is refused', () => {
    expect(
      ingestViolationsIn(FILE, "import { x } from '../../maintenance/src/sender';")
    ).toHaveLength(1);
    expect(ingestViolationsIn(FILE, "import { x } from '../../../test/support/db';")).toHaveLength(
      1
    );
  });

  test('a comment that names a package is not an import', () => {
    expect(
      ingestViolationsIn(FILE, "// import { x } from 'zod';\n/** see `from 'axios'` */")
    ).toEqual([]);
  });

  test('the ingest source imports nothing else', async () => {
    const root = resolve(import.meta.dir, '../..');
    const found = [];
    let files = 0;
    for await (const file of new Glob('**/*.ts').scan({ cwd: resolve(root, INGEST_ROOT) })) {
      files += 1;
      const path = `${INGEST_ROOT}/${file}`;
      found.push(...ingestViolationsIn(path, await Bun.file(resolve(root, path)).text()));
    }
    expect(files).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});
