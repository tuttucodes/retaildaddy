import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export function createAudioFilePath(audioOutDir, label = "speech", extension = "wav") {
  fs.mkdirSync(audioOutDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(audioOutDir, `${timestamp}-${label}.${extension}`);
}

export async function playAudio(filePath, playCommand = "") {
  if (playCommand) {
    const [command, ...args] = playCommand.split(/\s+/);
    await runCommand(command, [...args, filePath]);
    return;
  }

  if (os.platform() === "darwin") {
    await runCommand("afplay", [filePath]);
    return;
  }

  await runCommand("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath]);
}
