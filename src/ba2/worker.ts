/**
 * Worker thread entry: opens the archive, extracts its slice of entry indices
 * and reports progress to the parent.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Ba2Archive } from './reader.js';
import { extractEntries, type EntryExtractionOptions } from './extract-entries.js';

interface WorkerInput {
  archivePath: string;
  indices: number[];
  options: EntryExtractionOptions;
}

const data = workerData as WorkerInput;
const archive = Ba2Archive.open(data.archivePath);
let lastReport = 0;

try {
  const stats = extractEntries(archive, data.indices, data.options, (done, bytes) => {
    const now = Date.now();
    if (now - lastReport >= 100) {
      lastReport = now;
      parentPort?.postMessage({ type: 'progress', done, bytes });
    }
  });
  parentPort?.postMessage({ type: 'done', stats });
} catch (error) {
  parentPort?.postMessage({ type: 'failed', message: (error as Error).message });
} finally {
  archive.close();
}
