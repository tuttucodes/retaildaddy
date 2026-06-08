import readline from "node:readline/promises";
import process from "node:process";
import { SarvamClient } from "./sarvamClient.js";
import { DemoBrain } from "./brain.js";
import { loadDemoScript, loadProductKnowledge, findStepForQuestion } from "./demoScript.js";
import { createAudioFilePath, playAudio, playAudioInBrowser } from "./audioPlayer.js";
import { watchAudioInbox } from "./audioInbox.js";
import { startAudioCapture } from "./audioCapture.js";
import { ProductDemoController } from "./productDemoController.js";
import { GoogleMeetAgent } from "./googleMeetAgent.js";
import { requireSarvamKey } from "./config.js";

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

  async speak(text, label = "speech") {
    requireSarvamKey(this.config);
    this.logger.info(`Speaking: ${text.slice(0, 90)}${text.length > 90 ? "..." : ""}`);
    const audioPath = createAudioFilePath(this.config.paths.audioOutDir, label, "wav");
    await this.sarvamClient.textToSpeechStream(text, audioPath, {
      model: this.config.sarvam.ttsModel,
      languageCode: this.config.sarvam.ttsLanguageCode,
      speaker: this.config.sarvam.ttsSpeaker,
      pace: this.config.sarvam.ttsPace
    });
    if (this.config.audio.browserPlayback && this.demoController?.page) {
      await playAudioInBrowser(this.demoController.page, audioPath);
    } else {
      await playAudio(audioPath, this.config.audio.playCommand);
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
    return result.transcript || "";
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

  async prepareDemoSession({ withMeet = false, autoPresent } = {}) {
    requireSarvamKey(this.config);
    let productPage;

    if (withMeet) {
      await this.meetAgent.launch();
      productPage = await this.meetAgent.openProduct();
      await this.meetAgent.joinMeet({ autoPresent });
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

  async listenForAudioQuestions({ signal, onTranscript } = {}) {
    requireSarvamKey(this.config);
    await watchAudioInbox({
      inputDir: this.config.paths.audioInputDir,
      logger: this.logger,
      signal,
      onFile: async (filePath) => {
        const transcript = await this.transcribe(filePath);
        if (!transcript) {
          this.logger.warn(`No transcript for ${filePath}`);
          return;
        }
        this.logger.info(`Transcript: ${transcript}`);
        if (onTranscript) {
          await onTranscript(transcript, filePath);
        } else {
          await this.answerQuestion(transcript);
        }
      }
    });
  }

  startLiveAudioController({ onTranscript } = {}) {
    const abortController = new AbortController();
    const capture = startAudioCapture({
      captureCommand: this.config.audio.captureCommand,
      inputDir: this.config.paths.audioInputDir,
      logger: this.logger
    });
    const watcher = this.startAudioQuestionWatcher({
      signal: abortController.signal,
      onTranscript
    });

    return {
      capture,
      watcher,
      stop: async () => {
        abortController.abort();
        if (capture?.enabled) {
          await capture.stop();
        }
        await watcher.catch(() => {});
      }
    };
  }

  async runConfirmedLiveDemo({ listenAudio = true } = {}) {
    requireSarvamKey(this.config);
    await this.prepareDemoSession({ withMeet: true, autoPresent: false });

    let confirmed = false;
    let resolveConfirmation;
    const confirmation = new Promise((resolve) => {
      resolveConfirmation = resolve;
    });

    let liveAudio = null;
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
      capture = startAudioCapture({
        captureCommand: this.config.audio.captureCommand,
        inputDir: this.config.paths.audioInputDir,
        logger: this.logger
      });
      this.startAudioQuestionWatcher({ signal: abortController.signal });
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
