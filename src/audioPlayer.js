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

export async function playAudioInBrowser(page, filePath) {
  const audioBase64 = fs.readFileSync(filePath).toString("base64");
  await page.bringToFront();
  await page.evaluate(async (base64) => {
    const previous = document.querySelector("[data-ai-demo-audio='true']");
    if (previous) previous.remove();

    const status = document.createElement("div");
    status.dataset.aiDemoAudio = "true";
    status.textContent = "AI voice speaking";
    Object.assign(status.style, {
      position: "fixed",
      left: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      background: "#0f766e",
      color: "#ffffff",
      borderRadius: "8px",
      padding: "10px 14px",
      fontFamily:
        "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      fontSize: "14px",
      fontWeight: "700",
      letterSpacing: "0",
      boxShadow: "0 12px 36px rgba(0,0,0,0.22)"
    });
    document.body.appendChild(status);

    const audio = new Audio(`data:audio/wav;base64,${base64}`);
    audio.preload = "auto";
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error("Browser audio playback failed."));
      audio.play().catch(reject);
    });

    status.remove();
  }, audioBase64);
}
