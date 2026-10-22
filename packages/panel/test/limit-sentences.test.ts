import { describe, expect, test } from 'bun:test';
import { everyWindow, jobsCount, plainDuration } from '../src/pages/control/queue/limitSentences';

describe('limit sentences', () => {
  test('a duration uses the largest whole unit', () => {
    expect(plainDuration(1000)).toBe('1 second');
    expect(plainDuration(10_000)).toBe('10 seconds');
    expect(plainDuration(60_000)).toBe('1 minute');
    expect(plainDuration(90_000)).toBe('90 seconds');
    expect(plainDuration(7_200_000)).toBe('2 hours');
    expect(plainDuration(1500)).toBe('1500 ms');
  });

  test('a window reads as "every ..."', () => {
    expect(everyWindow(60_000)).toBe('every minute');
    expect(everyWindow(30_000)).toBe('every 30 seconds');
    expect(everyWindow(1500)).toBe('every 1500 ms');
  });

  test('a job count agrees with its number', () => {
    expect(jobsCount(1)).toBe('1 job');
    expect(jobsCount(100)).toBe('100 jobs');
  });
});
