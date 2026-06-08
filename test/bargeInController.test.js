import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BargeInController } from "../src/speech/bargeInController.js";

describe("BargeInController", () => {
  it("aborts the active speech controller when user speech arrives", () => {
    const bic = new BargeInController();
    const controller = new AbortController();
    bic.beginSpeaking(controller);
    assert.equal(bic.isSpeaking, true);
    const aborted = bic.onUserSpeech();
    assert.equal(aborted, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(bic.isSpeaking, false);
  });

  it("does nothing on user speech when not speaking", () => {
    const bic = new BargeInController();
    assert.equal(bic.onUserSpeech(), false);
  });

  it("clears state on endSpeaking", () => {
    const bic = new BargeInController();
    const controller = new AbortController();
    bic.beginSpeaking(controller);
    bic.endSpeaking();
    assert.equal(bic.isSpeaking, false);
    assert.equal(bic.onUserSpeech(), false);
  });
});
