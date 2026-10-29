/** Serialize memory-heavy archive jobs in a worker so buzzer timers remain responsive. */
import { Worker } from 'node:worker_threads';
import type { Package, PackHeader, ParseSiqOptions } from './siqParser.ts';
import type { ParseJob } from './parseWorker.ts';

interface QueuedJob {
  job: ParseJob;
  resolve(value: Package | PackHeader | boolean | string): void;
  reject(error: Error): void;
}

const queue: QueuedJob[] = [];
let running = false;
const MAX_PENDING_JOBS = 16;

function runNext(): void {
  if (running || !queue.length) return;
  running = true;
  const pending = queue.shift()!;
  let worker: Worker;
  try {
    // A packaged server extracts the compiled worker beside its other assets.
    worker = new Worker(process.env.SIGAME_PARSE_WORKER ?? new URL('./parseWorker.ts', import.meta.url), {
      workerData: pending.job,
      execArgv: process.env.SIGAME_PARSE_WORKER ? [] : ['--import', 'tsx'],
    });
  } catch (error) {
    pending.reject(error as Error);
    running = false;
    queueMicrotask(runNext);
    return;
  }
  let result: { ok: boolean; value?: Package | PackHeader | boolean | string; error?: string } | null = null;
  let failure: Error | null = null;
  worker.once('message', (message) => { result = message; });
  worker.once('error', (error) => { failure = error as Error; });
  worker.once('exit', (code) => {
    if (failure) pending.reject(failure);
    else if (!result || code !== 0) pending.reject(new Error(`Pack worker exited with code ${code}`));
    else if (!result.ok) pending.reject(new Error(result.error ?? 'Pack parsing failed'));
    else pending.resolve(result.value!);
    running = false;
    runNext();
  });
}

function runJob<T extends Package | PackHeader | boolean | string>(job: ParseJob): Promise<T> {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_PENDING_JOBS) {
      reject(new Error('Pack parser is busy; try again shortly'));
      return;
    }
    queue.push({ job, resolve: resolve as QueuedJob['resolve'], reject });
    runNext();
  });
}

export function readPackHeaderAsync(filePath: string): Promise<PackHeader> {
  return runJob({ kind: 'header', filePath });
}

export function parseSiqAsync(filePath: string, options?: ParseSiqOptions): Promise<Package> {
  return runJob({ kind: 'pack', filePath, options });
}

export function isSiqArchiveAsync(filePath: string): Promise<boolean> {
  return runJob({ kind: 'archive', filePath });
}

export function repackWorkshopFolderAsync(sourceDir: string, outPath: string): Promise<string> {
  return runJob({ kind: 'repack', sourceDir, outPath });
}
