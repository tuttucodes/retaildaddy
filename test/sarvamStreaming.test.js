import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SarvamStreamingStt } from "../src/sarvamStreaming.js";

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
}

describe("Sarvam streaming helpers", () => {
  it("sends raw PCM chunks with matching sample rate and codec metadata", async () => {
    FakeWebSocket.instances = [];
    const stt = new SarvamStreamingStt({
      apiKey: "sarvam-key",
      model: "saaras:v3",
      mode: "transcribe",
      languageCode: "unknown",
      sampleRate: 16000,
      inputAudioCodec: "pcm_s16le",
      WebSocketImpl: FakeWebSocket
    });

    await stt.connect();
    stt.sendPcm16(Buffer.from([1, 2, 3, 4]));

    const ws = FakeWebSocket.instances[0];
    const url = new URL(ws.url);
    const message = JSON.parse(ws.sent[0]);

    assert.equal(url.pathname, "/speech-to-text/ws");
    assert.equal(url.searchParams.get("sample_rate"), "16000");
    assert.equal(url.searchParams.get("input_audio_codec"), "pcm_s16le");
    assert.equal(ws.options.headers["Api-Subscription-Key"], "sarvam-key");
    assert.equal(message.audio.sample_rate, 16000);
    // Sarvam's per-message audio.encoding enum only accepts "audio/wav"; the real
    // codec is declared via the input_audio_codec query param (asserted above).
    assert.equal(message.audio.encoding, "audio/wav");
    assert.equal(message.audio.data, Buffer.from([1, 2, 3, 4]).toString("base64"));
  });
});
