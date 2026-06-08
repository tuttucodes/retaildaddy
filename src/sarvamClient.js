import fs from "node:fs";
import path from "node:path";

const SARVAM_BASE_URL = "https://api.sarvam.ai";
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchError(error) {
  return error?.name !== "AbortError";
}

export class SarvamClient {
  constructor({ apiKey, logger, fetchImpl = fetch, maxRetries = 2, retryDelayMs = 500 }) {
    this.apiKey = apiKey;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  async requestWithRetries(label, buildRequest, { maxRetries = this.maxRetries, signal } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response;
      try {
        const { url, init } = buildRequest();
        // Merge the optional abort signal into the fetch init so in-flight
        // requests are cancelled immediately when the caller aborts.
        const fetchInit = signal ? { ...init, signal } : init;
        response = await this.fetchImpl(url, fetchInit);
      } catch (error) {
        lastError = error;
        if (!isRetryableFetchError(error) || attempt === maxRetries) {
          throw error;
        }
      }

      if (response?.ok) return response;
      if (response) {
        const body = await response.text();
        lastError = new Error(`${label} failed with HTTP ${response.status}: ${body}`);
        if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxRetries) {
          throw lastError;
        }
      }

      const waitMs = this.retryDelayMs * 2 ** attempt;
      this.logger?.warn?.(`${label} failed; retrying in ${waitMs}ms.`);
      await delay(waitMs);
    }

    throw lastError;
  }

  async transcribeFile(filePath, options = {}) {
    const absolutePath = path.resolve(filePath);
    const fileBuffer = fs.readFileSync(absolutePath);
    const fileName = path.basename(absolutePath);

    const response = await this.requestWithRetries("Sarvam STT", () => {
      const formData = new FormData();
      formData.set("file", new Blob([fileBuffer]), fileName);
      formData.set("model", options.model || "saaras:v3");

      if (options.mode) formData.set("mode", options.mode);
      if (options.languageCode && options.languageCode !== "unknown") {
        formData.set("language_code", options.languageCode);
      }
      if (options.inputAudioCodec) formData.set("input_audio_codec", options.inputAudioCodec);
      if (options.withTimestamps != null) {
        formData.set("with_timestamps", String(Boolean(options.withTimestamps)));
      }

      return {
        url: `${SARVAM_BASE_URL}/speech-to-text`,
        init: {
          method: "POST",
          headers: {
            "api-subscription-key": this.apiKey
          },
          body: formData
        }
      };
    });

    const json = await response.json();
    return {
      ...json,
      transcript: String(json.transcript || json.text || "").trim()
    };
  }

  async textToSpeechStream(text, outputPath, options = {}) {
    const payload = {
      text,
      target_language_code: options.languageCode || "en-IN",
      speaker: options.speaker || "shubh",
      pace: options.pace ?? 1,
      model: options.model || "bulbul:v3",
      output_audio_codec: options.outputAudioCodec || "wav",
      speech_sample_rate: options.sampleRate || 24000,
      enable_preprocessing: options.enablePreprocessing ?? true,
      temperature: options.temperature ?? 0.6
    };

    const response = await this.requestWithRetries(
      "Sarvam TTS stream",
      () => ({
        url: `${SARVAM_BASE_URL}/text-to-speech/stream`,
        init: {
          method: "POST",
          headers: {
            "api-subscription-key": this.apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        }
      }),
      { signal: options.signal }
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, bytes);
    return outputPath;
  }

  /**
   * Synthesize speech as raw 8kHz mu-law bytes, ready to frame directly to Twilio.
   * Uses the REST /text-to-speech/stream endpoint with output_audio_codec "mulaw",
   * which returns raw mu-law audio (no WAV container) — the reliable telephony path.
   * @param {string} text
   * @param {{languageCode?: string, speaker?: string, model?: string, pace?: number, sampleRate?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<Buffer>} raw mu-law audio bytes
   */
  async textToSpeechMulaw(text, options = {}) {
    const payload = {
      text,
      target_language_code: options.languageCode || "en-IN",
      speaker: options.speaker || "shubh",
      pace: options.pace ?? 1,
      model: options.model || "bulbul:v3",
      output_audio_codec: "mulaw",
      speech_sample_rate: options.sampleRate || 8000
    };

    const response = await this.requestWithRetries(
      "Sarvam TTS mulaw",
      () => ({
        url: `${SARVAM_BASE_URL}/text-to-speech/stream`,
        init: {
          method: "POST",
          headers: {
            "api-subscription-key": this.apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        }
      }),
      { signal: options.signal }
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async analyzeCallFile(filePath, questions, options = {}) {
    const absolutePath = path.resolve(filePath);
    const fileBuffer = fs.readFileSync(absolutePath);
    const fileName = path.basename(absolutePath);
    const questionList = Array.isArray(questions) ? questions : [];

    const response = await this.requestWithRetries("Sarvam call analytics", () => {
      const formData = new FormData();
      formData.set("file", new Blob([fileBuffer]), fileName);
      formData.set("questions", JSON.stringify(questionList));
      if (options.hotwords) formData.set("hotwords", String(options.hotwords));
      if (options.model) formData.set("model", String(options.model));

      return {
        url: `${SARVAM_BASE_URL}/call-analytics`,
        init: {
          method: "POST",
          headers: {
            "api-subscription-key": this.apiKey
          },
          body: formData
        }
      };
    });

    return response.json();
  }

  async chat(messages, options = {}) {
    const response = await this.requestWithRetries("Sarvam chat", () => ({
      url: `${SARVAM_BASE_URL}/v1/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "api-subscription-key": this.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: options.model || "sarvam-105b",
          messages,
          reasoning_effort: options.reasoningEffort ?? null,
          temperature: options.temperature ?? 0.35,
          max_tokens: options.maxTokens ?? 600
        })
      }
    }));

    const json = await response.json();
    return json.choices?.[0]?.message?.content?.trim() || "";
  }
}
