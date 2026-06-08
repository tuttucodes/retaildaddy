import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  expandAudioCapturePlaceholders,
  parseAudioCaptureCommand,
  startAudioCapture,
  validateAudioCaptureOptions
} from "../src/audioCapture.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};

function quoteArg(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function commandLine(parts) {
  return parts.map(quoteArg).join(" ");
}

describe("audio capture command helpers", () => {
  it("parses commands with quoted arguments and escaped spaces", () => {
    const parsed = parseAudioCaptureCommand(
      'ffmpeg -f avfoundation -i ":BlackHole 2ch" "$AUDIO_INPUT_DIR/question %03d.wav" label\\ with\\ spaces'
    );

    assert.equal(parsed.command, "ffmpeg");
    assert.deepEqual(parsed.args, [
      "-f",
      "avfoundation",
      "-i",
      ":BlackHole 2ch",
      "$AUDIO_INPUT_DIR/question %03d.wav",
      "label with spaces"
    ]);
  });

  it("rejects malformed quoted commands", () => {
    assert.throws(
      () => parseAudioCaptureCommand('ffmpeg -i ":BlackHole 2ch'),
      /unterminated/
    );
    assert.throws(() => parseAudioCaptureCommand("ffmpeg -i input\\"), /dangling escape/);
  });

  it("expands AUDIO_INPUT_DIR placeholders after parsing", () => {
    const inputDir = path.join(os.tmpdir(), "retaildaddy audio input");
    const expanded = expandAudioCapturePlaceholders("${AUDIO_INPUT_DIR}/question.wav", {
      inputDir
    });

    assert.equal(expanded, path.join(inputDir, "question.wav"));
  });

  it("validates disabled capture without requiring an input directory", () => {
    const result = validateAudioCaptureOptions({ captureCommand: "" });

    assert.equal(result.enabled, false);
    assert.equal(result.command, "");
    assert.deepEqual(result.args, []);
  });

  it("requires AUDIO_INPUT_DIR when a capture command is configured", () => {
    assert.throws(
      () => validateAudioCaptureOptions({ captureCommand: "ffmpeg -version" }),
      /AUDIO_INPUT_DIR is required/
    );
  });

  it("returns parsed command details with an absolute input directory", () => {
    const inputDir = path.join(os.tmpdir(), "retaildaddy-recordings");
    const result = validateAudioCaptureOptions({
      captureCommand:
        'ffmpeg -f pulse -i rd_meet_out.monitor "${AUDIO_INPUT_DIR}/question-%03d.wav"',
      inputDir
    });

    assert.equal(result.enabled, true);
    assert.equal(result.command, "ffmpeg");
    assert.equal(result.inputDir, path.resolve(inputDir));
    assert.equal(result.args.at(-1), path.join(path.resolve(inputDir), "question-%03d.wav"));
  });

  it("starts a configured capture process with AUDIO_INPUT_DIR in the environment", async () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "retaildaddy-audio-capture-"));
    const outputFile = path.join(inputDir, "chunk.wav");
    const code =
      "require('node:fs').writeFileSync(require('node:path').join(process.env.AUDIO_INPUT_DIR,'chunk.wav'),'ok')";

    const capture = startAudioCapture({
      captureCommand: commandLine([process.execPath, "-e", code]),
      inputDir,
      logger: silentLogger
    });

    const result = await capture.exit;

    assert.equal(capture.enabled, true);
    assert.equal(result.code, 0);
    assert.equal(fs.readFileSync(outputFile, "utf8"), "ok");
  });
});
