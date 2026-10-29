/** Run ZIP inflation and XML parsing away from the game timer event loop. */
import { parentPort, workerData } from 'node:worker_threads';
import AdmZip from 'adm-zip';
import { isSiqArchive, parseSiq, readPackHeader, type ParseSiqOptions } from './siqParser.ts';

export type ParseJob =
  | { kind: 'header'; filePath: string }
  | { kind: 'pack'; filePath: string; options?: ParseSiqOptions }
  | { kind: 'archive'; filePath: string }
  | { kind: 'repack'; sourceDir: string; outPath: string };

const job = workerData as ParseJob;
try {
  let value;
  if (job.kind === 'header') value = readPackHeader(job.filePath);
  else if (job.kind === 'pack') value = await parseSiq(job.filePath, job.options);
  else if (job.kind === 'archive') value = isSiqArchive(job.filePath);
  else {
    // Workshop folders sometimes contain loose content.xml instead of a .siq.
    const zip = new AdmZip();
    zip.addLocalFolder(job.sourceDir);
    zip.writeZip(job.outPath);
    value = job.outPath;
  }
  parentPort?.postMessage({ ok: true, value });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: (error as Error).message });
}
