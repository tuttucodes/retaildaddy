// src/speech/bargeInController.js

/**
 * Tracks whether the agent is currently speaking and aborts that speech
 * the instant the human starts talking (barge-in), like a real conversation.
 */
export class BargeInController {
  constructor() {
    this._controller = null;
  }

  get isSpeaking() {
    return this._controller !== null;
  }

  /** @param {AbortController} controller controls the in-flight TTS playback */
  beginSpeaking(controller) {
    this._controller = controller;
  }

  endSpeaking() {
    this._controller = null;
  }

  /**
   * Called when fresh user speech is detected. Aborts current speech if any.
   * @returns {boolean} true if a speech was interrupted
   */
  onUserSpeech() {
    if (!this._controller) return false;
    const controller = this._controller;
    this._controller = null;
    controller.abort();
    return true;
  }
}
