import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt']);

/** One file of the build, held in memory: the server serves only what the build produced. */
export interface StaticFile {
  readonly type: string;
  readonly bytes: Uint8Array;
  readonly gzip: Uint8Array | null;
  readonly etag: string;
}

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

export const etagOf = (bytes: Uint8Array): string =>
  `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 22)}"`;

export function staticFile(path: string, bytes: Uint8Array): StaticFile {
  const ext = extension(path);
  const gzip =
    COMPRESSIBLE.has(ext) && bytes.length > 1024 ? Bun.gzipSync(new Uint8Array(bytes)) : null;
  return {
    type: MIME[ext] ?? 'application/octet-stream',
    bytes,
    gzip: gzip !== null && gzip.length < bytes.length ? gzip : null,
    etag: etagOf(bytes),
  };
}

/** Every file under `root`, by its URL path (`/assets/x.js`). The `.vite` manifest is not served. */
export function loadBuild(root: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== '.vite') walk(full);
        continue;
      }
      const url = `/${relative(root, full).split(sep).join('/')}`;
      files.set(url, staticFile(url, readFileSync(full)));
    }
  };
  walk(root);
  if (!files.has('/index.html')) {
    throw new Error(`${root} holds no index.html: build the panel first (bun run build)`);
  }
  return files;
}
