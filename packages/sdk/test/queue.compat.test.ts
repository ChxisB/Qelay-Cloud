import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Queue, QueueEvents, Worker } from '../src';

/**
 * The public methods of Qelay's `Queue` (upstream commit c43442c9, the class chain in
 * `src/client/queue/runtime/*.ts`), listed here because `../qelay` is not available to CI.
 * docs/compat.md must classify each one.
 */
const UPSTREAM =
  `add addBulk addJobLog changeJobDelay changeJobPriority clean cleanAsync clearJobLogs close
constructor count countAsync disconnect drain drainAsync extendJobLock forward getActive getActiveAsync
getActiveCount getChildrenValues getCompleted getCompletedAsync getCompletedCount getCountsPerPriority
getCountsPerPriorityAsync getCountsPerPriorityForGroup getDeduplicationJobId getDelayed getDelayedAsync
getDelayedCount getDependencies getDlq getDlqAsync getDlqConfig getDlqConfigAsync getDlqJobsAsync getDlqStats
getDlqStatsAsync getFailed getFailedAsync getFailedCount getGlobalConcurrency getGlobalRateLimit
getGroupActiveCount getGroupConcurrency getGroupJobs getGroupJobsCount getGroupRateLimit getGroupRateLimitTtl
getGroupsJobsCount getJob getJobCounts getJobCountsAsync getJobDependencies getJobDependenciesCount getJobLogs
getJobScheduler getJobSchedulers getJobSchedulersCount getJobState getJobs getJobsAsync getMetrics getPrioritized
getPrioritizedCount getRateLimitTtl getStallConfig getStallConfigAsync getWaiting getWaitingAsync
getWaitingChildren getWaitingChildrenCount getWaitingCount getWorkers getWorkersCount isGroupPaused isMaxed
isPaused isPausedAsync moveJobToCompleted moveJobToDelayed moveJobToFailed moveJobToWait moveJobToWaitingChildren
obliterate obliterateAsync pause pauseAsync pauseGroup promoteJob promoteJobs purgeDlq purgeDlqAsync rateLimit
remove removeAsync removeDeduplicationKey removeDlqJob removeDlqJobAsync removeGlobalConcurrency
removeGlobalConcurrencyAsync removeGlobalRateLimit removeGlobalRateLimitAsync removeGroupConcurrency
removeGroupRateLimit removeJobScheduler resume resumeAsync resumeGroup retryCompleted retryCompletedAsync retryDlq
retryDlqAsync retryDlqByFilter retryDlqByFilterAsync retryJob retryJobs setDlqConfig setDlqConfigAsync
setGlobalConcurrency setGlobalConcurrencyAsync setGlobalRateLimit setGlobalRateLimitAsync setGroupConcurrency
setGroupRateLimit setStallConfig setStallConfigAsync trimEvents updateJobData updateJobProgress upsertJobScheduler
waitJobUntilFinished waitUntilReady`.split(/\s+/);

/**
 * The public names of Qelay's `Worker` (the class chain in `src/client/worker/runtime/*.ts`) and of
 * its `QueueEvents` (`src/client/events.ts`), at the same commit. `RateLimitError` is a static.
 */
const UPSTREAM_WORKER =
  `constructor RateLimitError cancelAllJobs cancelJob close closing concurrency delay extendJobLocks
getNextJob getRateLimiterInfo isClosed isJobCancelled isPaused isRateLimited isRunning off on once pause
processJobManually rateLimit rateLimitGroup resume run startStalledCheckTimer waitUntilReady`.split(
    /\s+/
  );
const UPSTREAM_EVENTS = 'constructor close disconnect emitError on once waitUntilReady'.split(' ');

/** Helpers of the class chain that are not part of its API. */
const INTERNAL = new Set(['page']);

const doc = readFileSync(join(import.meta.dir, '../../../docs/compat.md'), 'utf8');

function mentioned(name: string): boolean {
  const word = (n: string) => new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`).test(doc);
  // A row may cover a method and its `Async` twin under one name: "`getStallConfig()` (+ `Async`)".
  return word(name) || (name.endsWith('Async') && word(name.slice(0, -'Async'.length)));
}

function methodsOf(cls: { prototype: object }): string[] {
  const names = new Set<string>();
  for (
    let proto: object | null = cls.prototype;
    proto !== null && proto !== Object.prototype && proto !== EventEmitter.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (typeof Object.getOwnPropertyDescriptor(proto, key)?.value === 'function') names.add(key);
    }
  }
  return [...names].filter((name) => !INTERNAL.has(name));
}

/** The text of one `##` section of the document. */
function section(heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  const end = doc.indexOf('\n## ', start + 1);
  return start < 0 ? '' : doc.slice(start, end < 0 ? undefined : end);
}

function mentionedIn(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
}

describe('docs/compat.md', () => {
  test('the upstream list is the 134 public names of the class chain, each once', () => {
    expect(UPSTREAM.length).toBe(134);
    expect(new Set(UPSTREAM).size).toBe(UPSTREAM.length);
  });

  test('classifies every method of Qelay’s Queue', () => {
    expect(UPSTREAM.filter((name) => !mentioned(name))).toEqual([]);
  });

  test('mentions every public method of this Queue', () => {
    expect(methodsOf(Queue).filter((name) => !mentioned(name))).toEqual([]);
  });

  test('every row of a table with a Status column carries one of the statuses', () => {
    const bad: string[] = [];
    let statusTable = false;
    let previous = '';
    for (const line of doc.split('\n')) {
      if (!line.startsWith('|')) {
        statusTable = false;
      } else if (line.startsWith('| ---')) {
        statusTable = previous.split('|')[2]?.trim() === 'Status';
      } else if (statusTable) {
        const status = line.split('|')[2]?.trim() ?? '';
        if (!/^(Supported|Differs|Not supported|New)\b/.test(status)) bad.push(line.slice(0, 60));
      }
      previous = line;
    }
    expect(bad).toEqual([]);
  });

  test('classifies every method of Qelay’s Worker, in its own section', () => {
    const text = section('`Worker`');
    expect(text.length).toBeGreaterThan(0);
    expect(UPSTREAM_WORKER.filter((name) => !mentionedIn(text, name))).toEqual([]);
    expect(methodsOf(Worker).filter((name) => !mentionedIn(text, name))).toEqual([]);
  });

  test('classifies every method of Qelay’s QueueEvents, in its own section', () => {
    const text = section('`QueueEvents`');
    expect(text.length).toBeGreaterThan(0);
    expect(UPSTREAM_EVENTS.filter((name) => !mentionedIn(text, name))).toEqual([]);
    expect(methodsOf(QueueEvents).filter((name) => !mentionedIn(text, name))).toEqual([]);
  });
});
