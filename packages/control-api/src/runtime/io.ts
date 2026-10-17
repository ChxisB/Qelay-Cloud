/** Where a command writes: stdout for what a script reads, stderr for what an operator reads. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}
