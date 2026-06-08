#!/usr/bin/env node
import process from "node:process";
import { loadConfig, requireSarvamKey } from "./config.js";
import { createLogger } from "./logger.js";
import { DemoOrchestrator } from "./orchestrator.js";
import { SarvamClient } from "./sarvamClient.js";
import { createAudioFilePath, playAudio } from "./audioPlayer.js";
import { loadDemoScript, loadProductKnowledge } from "./demoScript.js";
import { DemoBrain } from "./brain.js";
import { GoogleMeetAgent } from "./googleMeetAgent.js";
import { assertPreflightReady, formatPreflightReport, runPreflight } from "./preflight.js";

function usage() {
  console.log(`Usage:
  npm run agent -- auth
  npm run agent -- launch "https://meet.google.com/xxx-yyyy-zzz" [--product http://localhost:3000] [--listen-audio] [--manual-present]
  npm run agent -- doctor [rehearse|demo|launch]
  npm run rehearse
  npm run demo
  npm run agent -- ask "question"
  npm run agent -- stt path/to/audio.wav
  npm run agent -- tts "text"
  npm run agent -- listen-audio
`);
}

function parseLaunchArgs(args) {
  const options = {
    meetUrl: "",
    productUrl: "",
    listenAudio: false,
    autoPresent: true
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--product") {
      options.productUrl = args[index + 1] || "";
      index += 1;
    } else if (value === "--listen-audio") {
      options.listenAudio = true;
    } else if (value === "--auto-present") {
      options.autoPresent = true;
    } else if (value === "--manual-present") {
      options.autoPresent = false;
    } else if (!options.meetUrl) {
      options.meetUrl = value;
    }
  }

  return options;
}

function assertReady(config, mode) {
  const result = assertPreflightReady(config, { mode });
  if (result.warnings.length > 0) {
    console.warn(formatPreflightReport(result));
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const logger = createLogger("demo-agent");

  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  if (command === "auth") {
    const meetAgent = new GoogleMeetAgent({ config, logger });
    await meetAgent.authenticate();
    return;
  }

  if (command === "doctor") {
    const mode = args[0] || "launch";
    console.log(formatPreflightReport(runPreflight(config, { mode })));
    return;
  }

  if (command === "rehearse") {
    assertReady(config, "rehearse");
    const orchestrator = new DemoOrchestrator({ config, logger });
    await orchestrator.runScriptedDemo({ withMeet: false });
    await orchestrator.operatorLoop({ listenAudio: config.audio.autoListen });
    return;
  }

  if (command === "demo") {
    assertReady(config, "demo");
    const orchestrator = new DemoOrchestrator({ config, logger });
    await orchestrator.runScriptedDemo({ withMeet: true });
    await orchestrator.operatorLoop({
      listenAudio: config.audio.autoListen || Boolean(config.audio.captureCommand)
    });
    return;
  }

  if (command === "launch") {
    const launchOptions = parseLaunchArgs(args);
    if (!launchOptions.meetUrl) {
      throw new Error("Provide the Google Meet link: npm run agent -- launch \"https://meet.google.com/...\"");
    }

    config.browser.meetUrl = launchOptions.meetUrl;
    if (launchOptions.productUrl) config.browser.productUrl = launchOptions.productUrl;
    if (launchOptions.autoPresent != null) config.browser.autoPresent = launchOptions.autoPresent;

    assertReady(config, config.browser.autoPresent ? "launch" : "demo");
    const orchestrator = new DemoOrchestrator({ config, logger });
    await orchestrator.runScriptedDemo({ withMeet: true });
    await orchestrator.operatorLoop({
      listenAudio:
        launchOptions.listenAudio || config.audio.autoListen || Boolean(config.audio.captureCommand)
    });
    return;
  }

  if (command === "listen-audio") {
    const orchestrator = new DemoOrchestrator({ config, logger });
    await orchestrator.listenForAudioQuestions();
    return;
  }

  if (command === "stt") {
    const filePath = args[0];
    if (!filePath) throw new Error("Provide an audio file path.");
    requireSarvamKey(config);
    const client = new SarvamClient({ apiKey: config.sarvam.apiKey, logger });
    const result = await client.transcribeFile(filePath, {
      model: config.sarvam.sttModel,
      mode: config.sarvam.sttMode,
      languageCode: config.sarvam.sttLanguageCode
    });
    console.log(result.transcript || "");
    return;
  }

  if (command === "tts") {
    const text = args.join(" ");
    if (!text) throw new Error("Provide text to speak.");
    requireSarvamKey(config);
    const client = new SarvamClient({ apiKey: config.sarvam.apiKey, logger });
    const audioPath = createAudioFilePath(config.paths.audioOutDir, "manual", "wav");
    await client.textToSpeechStream(text, audioPath, {
      model: config.sarvam.ttsModel,
      languageCode: config.sarvam.ttsLanguageCode,
      speaker: config.sarvam.ttsSpeaker,
      pace: config.sarvam.ttsPace
    });
    await playAudio(audioPath, config.audio.playCommand);
    console.log(audioPath);
    return;
  }

  if (command === "ask") {
    const question = args.join(" ");
    if (!question) throw new Error("Provide a question.");
    requireSarvamKey(config);
    const script = loadDemoScript(config.paths.demoScript);
    const productKnowledge = loadProductKnowledge(config.paths.productKnowledge);
    const client = new SarvamClient({ apiKey: config.sarvam.apiKey, logger });
    const brain = new DemoBrain({ sarvamClient: client, config, script, productKnowledge });
    const answer = await brain.answer(question);
    console.log(answer);
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
