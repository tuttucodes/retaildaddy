import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const AUDIO_INPUT_DIR_PATTERN = /\$\{AUDIO_INPUT_DIR\}|\$AUDIO_INPUT_DIR/g;

function log(logger, level, message) {
  const target = logger?.[level] || logger?.log;
  if (typeof target === "function") {
    target.call(logger, message);
  }
}

function commandForLog(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function attachLineLogger(stream, logger, level, prefix) {
  if (!stream) return;

  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) log(logger, level, `${prefix}: ${line}`);
    }
  });
  stream.on("end", () => {
    if (pending.trim()) log(logger, level, `${prefix}: ${pending}`);
  });
}

export function parseAudioCaptureCommand(commandLine) {
  if (typeof commandLine !== "string") {
    throw new TypeError("AUDIO_CAPTURE_COMMAND must be a string.");
  }

  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let tokenStarted = false;

  for (const char of commandLine.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping) {
    throw new Error("AUDIO_CAPTURE_COMMAND ends with a dangling escape character.");
  }
  if (quote) {
    throw new Error(`AUDIO_CAPTURE_COMMAND has an unterminated ${quote} quote.`);
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  if (tokens.length === 0 || !tokens[0]) {
    throw new Error("AUDIO_CAPTURE_COMMAND is empty.");
  }

  return {
    command: tokens[0],
    args: tokens.slice(1)
  };
}

export function expandAudioCapturePlaceholders(value, { inputDir } = {}) {
  const absoluteInputDir = inputDir ? path.resolve(inputDir) : "";
  return value.replace(AUDIO_INPUT_DIR_PATTERN, absoluteInputDir);
}

export function validateAudioCaptureOptions({ captureCommand = "", inputDir } = {}) {
  if (captureCommand == null || captureCommand === "") {
    return {
      enabled: false,
      command: "",
      args: [],
      inputDir: inputDir ? path.resolve(inputDir) : undefined
    };
  }
  if (typeof captureCommand !== "string") {
    throw new TypeError("AUDIO_CAPTURE_COMMAND must be a string.");
  }
  if (!captureCommand.trim()) {
    return {
      enabled: false,
      command: "",
      args: [],
      inputDir: inputDir ? path.resolve(inputDir) : undefined
    };
  }
  if (typeof inputDir !== "string" || !inputDir.trim()) {
    throw new Error("AUDIO_INPUT_DIR is required when AUDIO_CAPTURE_COMMAND is set.");
  }
  if (captureCommand.includes("\0") || inputDir.includes("\0")) {
    throw new Error("Audio capture configuration must not contain null bytes.");
  }

  const absoluteInputDir = path.resolve(inputDir);
  const parsed = parseAudioCaptureCommand(captureCommand);
  const command = expandAudioCapturePlaceholders(parsed.command, { inputDir: absoluteInputDir });
  const args = parsed.args.map((arg) =>
    expandAudioCapturePlaceholders(arg, { inputDir: absoluteInputDir })
  );

  if ([command, ...args].some((value) => value.includes("\0"))) {
    throw new Error("AUDIO_CAPTURE_COMMAND must not contain null bytes.");
  }

  return {
    enabled: true,
    command,
    args,
    inputDir: absoluteInputDir
  };
}

function disabledAudioCapture({ inputDir, logger } = {}) {
  log(logger, "info", "Live audio capture disabled. Set AUDIO_CAPTURE_COMMAND to enable it.");
  return {
    enabled: false,
    pid: null,
    inputDir,
    command: "",
    args: [],
    child: null,
    exit: Promise.resolve({ disabled: true }),
    exited: () => true,
    stop: async () => ({ disabled: true })
  };
}

export function startAudioCapture({
  captureCommand = "",
  inputDir,
  logger = console,
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawn,
  stopTimeoutMs = 3000,
  onExit,
  onError
} = {}) {
  const options = validateAudioCaptureOptions({ captureCommand, inputDir });
  if (!options.enabled) {
    return disabledAudioCapture({ inputDir: options.inputDir, logger });
  }

  fs.mkdirSync(options.inputDir, { recursive: true });

  log(
    logger,
    "info",
    `Starting live audio capture into ${options.inputDir}: ${commandForLog(
      options.command,
      options.args
    )}`
  );

  const child = spawnImpl(options.command, options.args, {
    cwd,
    env: {
      ...env,
      AUDIO_INPUT_DIR: options.inputDir
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stopping = false;
  let exited = false;
  let exitResult;
  let spawnError;

  attachLineLogger(child.stdout, logger, "info", "audio-capture stdout");
  attachLineLogger(child.stderr, logger, "warn", "audio-capture stderr");

  const exit = new Promise((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
      log(logger, "error", `Audio capture failed to start: ${error.message}`);
      if (onError) onError(error);
    });

    child.on("close", (code, signal) => {
      exited = true;
      exitResult = { code, signal, error: spawnError };

      if (spawnError) {
        // The error event already logged the startup failure.
      } else if (stopping) {
        log(logger, "info", `Audio capture stopped with code ${code ?? "null"} signal ${signal ?? "null"}.`);
      } else if (code === 0) {
        log(logger, "info", "Audio capture process exited normally.");
      } else {
        log(logger, "warn", `Audio capture exited unexpectedly with code ${code ?? "null"} signal ${signal ?? "null"}.`);
      }

      if (onExit) onExit(exitResult);
      resolve(exitResult);
    });
  });

  return {
    enabled: true,
    pid: child.pid,
    inputDir: options.inputDir,
    command: options.command,
    args: options.args,
    child,
    exit,
    exited: () => exited,
    stop: async ({ signal = "SIGTERM", timeoutMs = stopTimeoutMs } = {}) => {
      if (exited) return exitResult;

      stopping = true;
      log(logger, "info", `Stopping audio capture process ${child.pid} with ${signal}.`);
      child.kill(signal);

      if (timeoutMs > 0) {
        const timeout = new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (!exited) {
              log(
                logger,
                "warn",
                `Audio capture process ${child.pid} did not stop within ${timeoutMs}ms; sending SIGKILL.`
              );
              child.kill("SIGKILL");
            }
            resolve();
          }, timeoutMs);

          exit.finally(() => clearTimeout(timer));
        });

        await Promise.race([exit, timeout]);
      }

      return exit;
    }
  };
}
