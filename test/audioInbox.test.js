import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchAudioInbox } from "../src/audioInbox.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

function writeToneWav(filePath, { samples = 16_000, sampleRate = 16_000 } = {}) {
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12_000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }

  fs.writeFileSync(filePath, buffer);
}

describe("audio inbox watcher", () => {
  it("ignores files that existed before the watcher started", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-audio-inbox-"));
    writeToneWav(path.join(inputDir, "old.wav"));
    const abortController = new AbortController();
    const processed = [];

    const watcher = watchAudioInbox({
      inputDir,
      logger: silentLogger,
      pollMs: 10,
      signal: abortController.signal,
      onFile: async (filePath) => {
        processed.push(filePath);
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    abortController.abort();
    await watcher;

    assert.deepEqual(processed, []);
  });

  it("processes a new audio file only after it is stable", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-audio-inbox-"));
    const abortController = new AbortController();
    const processed = [];

    const watcher = watchAudioInbox({
      inputDir,
      logger: silentLogger,
      pollMs: 10,
      stablePolls: 2,
      signal: abortController.signal,
      onFile: async (filePath) => {
        processed.push(path.basename(filePath));
        abortController.abort();
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeToneWav(path.join(inputDir, "new.wav"));
    await watcher;

    assert.deepEqual(processed, ["new.wav"]);
  });
});
