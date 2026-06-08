import fs from "node:fs";
import path from "node:path";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".webm", ".m4a", ".aac", ".flac", ".ogg"]);

export function wavRmsLevel(filePath) {
  const buffer = fs.readFileSync(filePath);
  const dataMarker = Buffer.from("data");
  const dataIndex = buffer.indexOf(dataMarker);
  const start = dataIndex >= 0 ? dataIndex + 8 : 44;
  if (buffer.length <= start + 2) return 0;

  let sumSquares = 0;
  let samples = 0;
  for (let index = start; index + 1 < buffer.length; index += 2) {
    const sample = buffer.readInt16LE(index) / 32768;
    sumSquares += sample * sample;
    samples += 1;
  }

  return samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
}

export function shouldProcessAudioFile(filePath, { minBytes = 24000, minRms = 0.002 } = {}) {
  const stat = fs.statSync(filePath);
  if (stat.size < minBytes) return false;

  if (path.extname(filePath).toLowerCase() === ".wav") {
    return wavRmsLevel(filePath) >= minRms;
  }

  return true;
}

export function listAudioFiles(inputDir) {
  if (!fs.existsSync(inputDir)) {
    fs.mkdirSync(inputDir, { recursive: true });
    return [];
  }

  return fs
    .readdirSync(inputDir)
    .filter((fileName) => AUDIO_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
    .map((fileName) => path.join(inputDir, fileName))
    .sort();
}

function waitForNextPoll(pollMs, signal) {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, pollMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function watchAudioInbox({
  inputDir,
  onFile,
  logger,
  pollMs = 1500,
  stablePolls = 1,
  minBytes = 24000,
  minRms = 0.002,
  shouldAcceptFile,
  signal
}) {
  fs.mkdirSync(inputDir, { recursive: true });
  const existingFiles = listAudioFiles(inputDir);
  const seen = new Set(existingFiles);
  const pending = new Map();
  const requiredStablePolls = Math.max(1, Number(stablePolls) || 1);
  logger.info(
    `Watching ${inputDir} for audio files.${existingFiles.length ? ` Ignoring ${existingFiles.length} existing file(s).` : ""}`
  );

  while (!signal?.aborted) {
    const files = listAudioFiles(inputDir);
    for (const file of files) {
      if (signal?.aborted) break;
      if (seen.has(file)) continue;

      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        pending.delete(file);
        continue;
      }
      const previous = pending.get(file);
      const current = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        stableCount:
          previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs
            ? previous.stableCount + 1
            : 0
      };

      if (!previous) {
        pending.set(file, current);
        continue;
      }

      if (current.stableCount < requiredStablePolls) {
        pending.set(file, current);
        continue;
      }

      pending.delete(file);
      seen.add(file);
      let shouldProcess;
      try {
        shouldProcess = shouldProcessAudioFile(file, { minBytes, minRms });
      } catch (error) {
        logger.warn(`Skipping unreadable audio file ${path.basename(file)}: ${error.message}`);
        continue;
      }

      if (!shouldProcess) {
        logger.info(`Skipping silent or tiny audio file ${path.basename(file)}.`);
        continue;
      }
      if (shouldAcceptFile && !(await shouldAcceptFile(file))) {
        continue;
      }
      try {
        await onFile(file);
      } catch (error) {
        logger.warn(`Ignoring audio file ${path.basename(file)}: ${error.message}`);
      }
    }

    await waitForNextPoll(pollMs, signal);
  }

  logger.info(`Stopped watching ${inputDir}.`);
}
