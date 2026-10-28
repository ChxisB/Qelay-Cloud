#!/usr/bin/env bun
import { main } from './importCli';

const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());

process.exitCode = await main(
  process.argv.slice(2),
  process.env,
  { out: (line) => console.log(line), err: (line) => console.error(line) },
  {},
  stop.signal
);
