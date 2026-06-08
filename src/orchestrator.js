import readline from "node:readline/promises";
import process from "node:process";
import { SarvamClient } from "./sarvamClient.js";
import { DemoBrain } from "./brain.js";
import { loadDemoScript, loadProductKnowledge, findStepForQuestion } from "./demoScript.js";
import { createAudioFilePath, playAudio, playAudioInBrowser } from "./audioPlayer.js";
import { watchAudioInbox } from "./audioInbox.js";
import { startAudioCapture } from "./audioCapture.js";
import { startLiveAudioStream } from "./liveAudioStream.js";
import { ProductDemoController } from "./productDemoController.js";
import { GoogleMeetAgent } from "./googleMeetAgent.js";
import { requireSarvamKey } from "./config.js";
import { BargeInController } from "./speech/bargeInController.js";
import { withRetry } from "./util/retry.js";

const DUPLICATE_TRANSCRIPT_WINDOW_MS = 20_000;
const AGENT_ECHO_WINDOW_MS = 90_000;
const FILLER_TRANSCRIPTS = new Set([
  "ah",
  "aha",
  "hmm",
  "hm",
  "ok",
  "okay",
  "uh",
  "um",
  "yeah",
  "yes",
  "അം",
  "ആ",
  "ആം",
  "ഓ",
  "ഹം",
  "ഹ്മ്",
  "മ്മ്",
  "ശരി"
]);

function detectSarvamTtsLanguageCode(text, fallback = "en-IN") {
  const value = String(text || "");
  if (/[\u0d00-\u0d7f]/u.test(value)) return "ml-IN";
  if (/[\u0900-\u097f]/u.test(value)) return "hi-IN";
  if (/[\u0b80-\u0bff]/u.test(value)) return "ta-IN";
  if (/[\u0c00-\u0c7f]/u.test(value)) return "te-IN";
  if (/[\u0c80-\u0cff]/u.test(value)) return "kn-IN";
  if (/[\u0980-\u09ff]/u.test(value)) return "bn-IN";
  if (/[\u0a80-\u0aff]/u.test(value)) return "gu-IN";
  if (/[\u0a00-\u0a7f]/u.test(value)) return "pa-IN";
  return fallback;
}

function normalizeLiveTranscript(text) {
  return String(text || "")
    .toLocaleLowerCase("en-IN")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text) {
  return new Set(normalizeLiveTranscript(text).split(" ").filter(Boolean));
}

function transcriptSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function isLikelyNoiseTranscript(normalized) {
  if (!normalized) return true;
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 1 && FILLER_TRANSCRIPTS.has(tokens[0])) return true;
  return normalized.length < 3;
}

export class DemoOrchestrator {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.script = loadDemoScript(config.paths.demoScript);
    this.productKnowledge = loadProductKnowledge(config.paths.productKnowledge);
    this.sarvamClient = new SarvamClient({
      apiKey: config.sarvam.apiKey,
      logger
    });
    this.brain = new DemoBrain({
      sarvamClient: this.sarvamClient,
      config,
      script: this.script,
      productKnowledge: this.productKnowledge
    });
    this.meetAgent = new GoogleMeetAgent({ config, logger });
    this.demoController = null;
    this.questionQueue = Promise.resolve();
    this.recentLiveTranscripts = [];
    this.recentAgentUtterances = [];
    this.bargeIn = new BargeInController();
  }

  isDemoStartConfirmation(transcript) {
    const normalized = String(transcript || "").trim();
    if (!normalized) return false;

    try {
      return new RegExp(this.config.agent.confirmationPattern, "iu").test(normalized);
    } catch {
      return /start demo|start presenting|go ahead|you can start|do it/i.test(normalized);
    }
  }

  async playWithSignal(audioPath, signal) {
    if (this.config.audio.browserPlayback && this.demoController?.page) {
      await playAudioInBrowser(this.demoController.page, audioPath);
    } else {
      await playAudio(audioPath, this.config.audio.playCommand, { signal });
    }
  }

  async speak(text, label = "speech") {
    requireSarvamKey(this.config);
    this.logger.info(`Speaking: ${text.slice(0, 90)}${text.length > 90 ? "..." : ""}`);
    this.rememberAgentSpeech(text);
    const audioPath = createAudioFilePath(this.config.paths.audioOutDir, label, "wav");
    const languageCode = this.config.agent.multilingual
      ? detectSarvamTtsLanguageCode(text, "en-IN")
      : this.config.sarvam.ttsLanguageCode;
    await this.sarvamClient.textToSpeechStream(text, audioPath, {
      model: this.config.sarvam.ttsModel,
      languageCode,
      speaker: this.config.sarvam.ttsSpeaker,
      pace: this.config.sarvam.ttsPace
    });
    const controller = new AbortController();
    this.bargeIn.beginSpeaking(controller);
    try {
      await this.playWithSignal(audioPath, controller.signal);
    } finally {
      this.bargeIn.endSpeaking();
    }
    return audioPath;
  }

  async transcribe(filePath) {
    requireSarvamKey(this.config);
    const result = await this.sarvamClient.transcribeFile(filePath, {
      model: this.config.sarvam.sttModel,
      mode: this.config.sarvam.sttMode,
      languageCode: this.config.sarvam.sttLanguageCode
    });
    return String(result.transcript || result.text || "").trim();
  }

  rememberAgentSpeech(text) {
    const normalized = normalizeLiveTranscript(text);
    if (!normalized) return;

    const now = Date.now();
    this.recentAgentUtterances.push({ normalized, at: now });
    this.recentAgentUtterances = this.recentAgentUtterances.filter(
      (entry) => now - entry.at <= AGENT_ECHO_WINDOW_MS
    );
  }

  rememberLiveTranscript(transcript) {
    const normalized = normalizeLiveTranscript(transcript);
    if (!normalized) return;

    const now = Date.now();
    this.recentLiveTranscripts.push({ normalized, at: now });
    this.recentLiveTranscripts = this.recentLiveTranscripts.filter(
      (entry) => now - entry.at <= DUPLICATE_TRANSCRIPT_WINDOW_MS
    );
  }

  liveTranscriptIgnoreReason(transcript) {
    const normalized = normalizeLiveTranscript(transcript);
    if (!normalized) return "empty transcript";

    if (this.isDemoStartConfirmation(transcript)) {
      return "";
    }

    if (isLikelyNoiseTranscript(normalized)) {
      return "short filler/noise";
    }

    const now = Date.now();
    const duplicate = this.recentLiveTranscripts.find(
      (entry) => entry.normalized === normalized && now - entry.at <= DUPLICATE_TRANSCRIPT_WINDOW_MS
    );
    if (duplicate) return "duplicate transcript";

    const echoedSpeech = this.recentAgentUtterances.find(
      (entry) =>
        now - entry.at <= AGENT_ECHO_WINDOW_MS &&
        transcriptSimilarity(normalized, entry.normalized) >= 0.78
    );
    if (echoedSpeech) return "probable agent audio echo";

    return "";
  }

  async handleLiveTranscript(transcript, filePath, { onTranscript } = {}) {
    if (this.bargeIn.isSpeaking) {
      this.bargeIn.onUserSpeech();
      this.logger.info("Barge-in: user spoke while agent was talking; stopped playback.");
    }
    const reason = this.liveTranscriptIgnoreReason(transcript);
    if (reason) {
      this.logger.info(`Ignoring live transcript from ${filePath}: ${reason}.`);
      return;
    }

    this.rememberLiveTranscript(transcript);
    this.logger.info(`Transcript: ${transcript}`);
    if (onTranscript) {
      await onTranscript(transcript, filePath);
    } else {
      await this.answerQuestion(transcript);
    }
  }

  async answerQuestion(question, { speak = true, focusFeature = true } = {}) {
    this.questionQueue = this.questionQueue.catch(() => {}).then(async () => {
      this.logger.info(`Question: ${question}`);
      const step = findStepForQuestion(this.script, question);
      if (focusFeature && step && this.demoController) {
        this.logger.info(`Revisiting feature: ${step.title}`);
        await this.demoController.runStep(step);
      }

      const answer = await this.brain.answer(question);
      this.logger.info(`Answer: ${answer}`);
      if (speak) await this.speak(answer, "answer");
      return answer;
    });

    return this.questionQueue;
  }

  buildJoinIntro() {
    return "Hi everyone, thanks for hopping on. I'm from the RetailDaddy team — give me one second and I'll share my screen and walk you through it.";
  }

  async joinMeetWithRetry({ autoPresent } = {}) {
    const retries = this.config.meet?.joinRetries ?? 1;
    await withRetry(
      () => this.meetAgent.joinMeet({ autoPresent }),
      { retries, baseDelayMs: 1500, onRetry: (n, e) => this.logger.warn(`Meet join retry ${n}: ${e.message}`) }
    );
  }

  async prepareDemoSession({ withMeet = false, autoPresent } = {}) {
    requireSarvamKey(this.config);
    let productPage;

    if (withMeet) {
      await this.meetAgent.launch();
      productPage = await this.meetAgent.openProduct();
      await this.joinMeetWithRetry({ autoPresent });
    } else {
      await this.meetAgent.launch();
      productPage = await this.meetAgent.openProduct();
    }

    this.demoController = new ProductDemoController({
      page: productPage,
      productUrl: this.config.browser.productUrl,
      logger: this.logger
    });

    return productPage;
  }

  async runPreparedScriptedDemo() {
    if (!this.demoController) {
      throw new Error("Demo session is not prepared. Call prepareDemoSession first.");
    }

    const productPage = this.demoController.page;
    await productPage.bringToFront();
    let canPresent = true;
    try {
      if (this.config.browser.autoPresent) await this.meetAgent.tryStartPresenting();
    } catch (error) {
      canPresent = false;
      this.logger.error(`Screen share failed; continuing audio-only and narrating screens: ${error.message}`);
    }
    if (!canPresent) {
      await this.speak("I'm having a small screen-share hiccup, so I'll walk you through it by voice and fix the share in a moment.", "share-fallback");
    }
    await this.speak(this.script.opening, "opening");

    for (const step of this.script.steps) {
      await this.demoController.runStep(step);
      await this.speak(step.say, step.id);
    }

    await this.speak(this.script.closing, "closing");
    this.logger.info("Scripted demo complete. Browser remains open until you stop the process.");
  }

  async runScriptedDemo({ withMeet = false } = {}) {
    await this.prepareDemoSession({ withMeet });
    await this.runPreparedScriptedDemo();
  }

  startAudioQuestionWatcher({ signal, onTranscript } = {}) {
    const watcher = this.listenForAudioQuestions({ signal, onTranscript }).catch((error) => {
      this.logger.error(`Audio question watcher stopped: ${error.message}`);
    });
    return watcher;
  }

  startMeetCaptionWatcher({ signal, onTranscript } = {}) {
    if (!this.config.audio.captionListen || !this.meetAgent?.meetPage) {
      return null;
    }

    const watcher = this.listenForMeetCaptions({ signal, onTranscript }).catch((error) => {
      this.logger.error(`Meet caption watcher stopped: ${error.message}`);
    });
    return watcher;
  }

  async listenForMeetCaptions({ signal, onTranscript } = {}) {
    const enabled = await this.meetAgent.enableCaptions();
    if (!enabled) return;

    this.logger.info("Watching Google Meet captions for fallback live input.");
    let lastCaption = "";
    while (!signal?.aborted) {
      const caption = await this.meetAgent.getLatestCaptionText();
      if (caption && caption !== lastCaption) {
        lastCaption = caption;
        await this.handleLiveTranscript(caption, "meet-captions", { onTranscript });
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.audio.captionPollMs));
    }
    this.logger.info("Stopped watching Google Meet captions.");
  }

  async shouldAcceptMeetAudioFile(filePath) {
    if (!this.config.audio.requireRemoteUnmuted || !this.meetAgent?.meetPage) {
      return true;
    }

    const state = await this.meetAgent.getRemoteAudioState();
    if (state.remoteUnmuted) {
      return true;
    }

    this.logger.info(
      `Skipping ${filePath}: no unmuted remote participant detected (${state.reason}).`
    );
    return false;
  }

  async listenForAudioQuestions({ signal, onTranscript } = {}) {
    requireSarvamKey(this.config);
    await watchAudioInbox({
      inputDir: this.config.paths.audioInputDir,
      logger: this.logger,
      pollMs: this.config.audio.inboxPollMs,
      stablePolls: this.config.audio.inboxStablePolls,
      minBytes: this.config.audio.minBytes,
      minRms: this.config.audio.minRms,
      signal,
      shouldAcceptFile: (filePath) => this.shouldAcceptMeetAudioFile(filePath),
      onFile: async (filePath) => {
        const transcript = await this.transcribe(filePath);
        if (!transcript) {
          this.logger.warn(`No transcript for ${filePath}`);
          return;
        }
        await this.handleLiveTranscript(transcript, filePath, { onTranscript });
      }
    });
  }

  startLiveAudioController({ onTranscript } = {}) {
    const abortController = new AbortController();
    const stream = startLiveAudioStream({
      streamCommand: this.config.audio.streamCommand,
      apiKey: this.config.sarvam.apiKey,
      logger: this.logger,
      sampleRate: this.config.audio.streamSampleRate,
      model: this.config.sarvam.sttModel,
      mode: this.config.sarvam.sttMode,
      languageCode: this.config.sarvam.sttLanguageCode,
      signal: abortController.signal,
      onTranscript: async (transcript, source) => {
        await this.handleLiveTranscript(transcript, source, { onTranscript });
      }
    });
    const capture = stream.enabled
      ? null
      : startAudioCapture({
          captureCommand: this.config.audio.captureCommand,
          inputDir: this.config.paths.audioInputDir,
          logger: this.logger
        });
    const watcher = stream.enabled
      ? Promise.resolve()
      : this.startAudioQuestionWatcher({
          signal: abortController.signal,
          onTranscript
        });
    const captionWatcher = this.startMeetCaptionWatcher({
      signal: abortController.signal,
      onTranscript
    });

    return {
      capture,
      watcher,
      stop: async () => {
        abortController.abort();
        if (stream?.enabled) {
          await stream.stop();
        }
        if (capture?.enabled) {
          await capture.stop();
        }
        await watcher.catch(() => {});
        await captionWatcher?.catch(() => {});
      }
    };
  }

  async runConfirmedLiveDemo({ listenAudio = true } = {}) {
    requireSarvamKey(this.config);
    await this.prepareDemoSession({ withMeet: true, autoPresent: false });
    await this.speak(this.buildJoinIntro(), "join-intro");

    let confirmed = false;
    let resolveConfirmation;
    const confirmation = new Promise((resolve) => {
      resolveConfirmation = resolve;
    });

    let liveAudio = null;
    let acknowledgedStandby = false;
    if (listenAudio) {
      this.logger.info(
        "Standby mode active. The agent will listen silently and wait for explicit confirmation before presenting or speaking."
      );
      liveAudio = this.startLiveAudioController({
        onTranscript: async (transcript) => {
          if (!confirmed) {
            if (this.isDemoStartConfirmation(transcript)) {
              confirmed = true;
              this.logger.info(`Demo confirmation received: ${transcript}`);
              resolveConfirmation(transcript);
            } else if (!acknowledgedStandby && /\b(hello|hi|hey|can you hear|are you listening)\b/i.test(transcript)) {
              acknowledgedStandby = true;
              this.logger.info(`Standby greeting received: ${transcript}`);
              await this.speak(
                "Hi, I can hear you. Say start demo when you want me to share screen and present RetailDaddy.",
                "standby-ack"
              );
            } else {
              this.logger.info(`Heard before confirmation; staying silent: ${transcript}`);
            }
            return;
          }

          await this.answerQuestion(transcript);
        }
      });
    } else if (process.stdin.isTTY) {
      this.logger.info("Type 'start demo' and press Enter to begin presenting.");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      for (;;) {
        const line = await rl.question("confirm> ");
        if (this.isDemoStartConfirmation(line)) {
          confirmed = true;
          rl.close();
          resolveConfirmation(line);
          break;
        }
      }
    } else {
      throw new Error(
        "Confirmation mode requires audio listening or an interactive TTY. Set MEET_WAIT_FOR_CONFIRMATION=false to auto-start."
      );
    }

    try {
      await confirmation;
      if (this.config.browser.autoPresent) {
        await this.meetAgent.tryStartPresenting();
      }
      await this.runPreparedScriptedDemo();

      if (listenAudio) {
        this.logger.info("Demo complete. Continuing to listen for client questions until stopped.");
        await this.waitForShutdownSignal();
      } else {
        await this.operatorLoop({ listenAudio: false });
      }
    } finally {
      if (liveAudio) {
        await liveAudio.stop();
      }
    }
  }

  async runVoiceAgent({ withMeet = true, listenAudio = true } = {}) {
    requireSarvamKey(this.config);
    if (withMeet) {
      await this.meetAgent.launch();
      await this.meetAgent.joinMeet({ autoPresent: false });
    }

    this.logger.info("Voice agent is live. Listening and answering every detected client utterance.");
    const liveAudio = listenAudio
      ? this.startLiveAudioController({
          onTranscript: async (transcript) => {
            await this.answerQuestion(transcript, { focusFeature: false });
          }
        })
      : null;

    try {
      if (process.stdin.isTTY) {
        await this.interactiveQa();
      } else if (liveAudio) {
        await this.waitForShutdownSignal();
      } else {
        this.logger.warn("Voice agent has no audio listener and no interactive TTY.");
      }
    } finally {
      if (liveAudio) {
        await liveAudio.stop();
      }
    }
  }

  async interactiveQa() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    for (;;) {
      const question = await rl.question("client> ");
      if (!question || ["exit", "quit"].includes(question.trim().toLowerCase())) {
        break;
      }
      await this.answerQuestion(question.trim());
    }

    rl.close();
  }

  async waitForShutdownSignal() {
    await new Promise((resolve) => {
      const done = () => resolve();
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  }

  async operatorLoop({ listenAudio = false } = {}) {
    const abortController = new AbortController();
    let capture = null;

    if (listenAudio) {
      this.logger.info("Audio question watcher is enabled.");
      const stream = startLiveAudioStream({
        streamCommand: this.config.audio.streamCommand,
        apiKey: this.config.sarvam.apiKey,
        logger: this.logger,
        sampleRate: this.config.audio.streamSampleRate,
        model: this.config.sarvam.sttModel,
        mode: this.config.sarvam.sttMode,
        languageCode: this.config.sarvam.sttLanguageCode,
        signal: abortController.signal,
        onTranscript: async (transcript, source) => {
          await this.handleLiveTranscript(transcript, source);
        }
      });
      capture = stream.enabled
        ? stream
        : startAudioCapture({
            captureCommand: this.config.audio.captureCommand,
            inputDir: this.config.paths.audioInputDir,
            logger: this.logger
          });
      if (!stream.enabled) {
        this.startAudioQuestionWatcher({ signal: abortController.signal });
      }
    }

    try {
      if (process.stdin.isTTY) {
        await this.interactiveQa();
      } else if (listenAudio) {
        this.logger.info("No interactive TTY detected. Staying alive for audio Q&A until SIGINT/SIGTERM.");
        await this.waitForShutdownSignal();
      } else {
        this.logger.warn("No interactive TTY detected and audio listening is disabled. Operator loop is ending.");
      }
    } finally {
      abortController.abort();
      if (capture?.enabled) {
        await capture.stop();
      }
    }
  }

  async close() {
    await this.meetAgent.close();
  }
}
