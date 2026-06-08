import fs from "node:fs";
import path from "node:path";

const SARVAM_BASE_URL = "https://api.sarvam.ai";

function ensureOkResponse(response, label) {
  if (response.ok) return response;
  return response.text().then((body) => {
    throw new Error(`${label} failed with HTTP ${response.status}: ${body}`);
  });
}

export class SarvamClient {
  constructor({ apiKey, logger }) {
    this.apiKey = apiKey;
    this.logger = logger;
  }

  async transcribeFile(filePath, options = {}) {
    const absolutePath = path.resolve(filePath);
    const fileBuffer = fs.readFileSync(absolutePath);
    const fileName = path.basename(absolutePath);

    const formData = new FormData();
    formData.set("file", new Blob([fileBuffer]), fileName);
    formData.set("model", options.model || "saaras:v3");

    if (options.mode) formData.set("mode", options.mode);
    if (options.languageCode) formData.set("language_code", options.languageCode);
    if (options.inputAudioCodec) formData.set("input_audio_codec", options.inputAudioCodec);
    if (options.withTimestamps != null) {
      formData.set("with_timestamps", String(Boolean(options.withTimestamps)));
    }

    const response = await fetch(`${SARVAM_BASE_URL}/speech-to-text`, {
      method: "POST",
      headers: {
        "api-subscription-key": this.apiKey
      },
      body: formData
    });

    await ensureOkResponse(response, "Sarvam STT");
    return response.json();
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

    const response = await fetch(`${SARVAM_BASE_URL}/text-to-speech/stream`, {
      method: "POST",
      headers: {
        "api-subscription-key": this.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    await ensureOkResponse(response, "Sarvam TTS stream");
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, bytes);
    return outputPath;
  }

  async chat(messages, options = {}) {
    const response = await fetch(`${SARVAM_BASE_URL}/v1/chat/completions`, {
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
    });

    await ensureOkResponse(response, "Sarvam chat");
    const json = await response.json();
    return json.choices?.[0]?.message?.content?.trim() || "";
  }
}
