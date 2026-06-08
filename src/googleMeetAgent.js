import fs from "node:fs";
import path from "node:path";

export class GoogleMeetAgent {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.context = null;
    this.meetPage = null;
    this.productPage = null;
    this.diagnosticIndex = 0;
  }

  async launch() {
    const { chromium } = await import("playwright");
    const profileDir = path.resolve(this.config.paths.chromeProfileDir);
    const browserArgs = this.buildChromiumArgs();

    const launchOptions = {
      headless: this.config.browser.headless,
      viewport: {
        width: this.config.browser.viewportWidth,
        height: this.config.browser.viewportHeight
      },
      args: browserArgs
    };

    if (this.config.browser.channel) {
      launchOptions.channel = this.config.browser.channel;
    }

    this.context = await chromium.launchPersistentContext(profileDir, launchOptions);

    this.context.setDefaultTimeout(12000);
    this.logger.info(
      `Launching Meet browser${this.config.browser.channel ? ` with channel '${this.config.browser.channel}'` : ""}.`
    );
    await this.grantMeetPermissions();
    return this.context;
  }

  buildChromiumArgs() {
    const args = [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
      "--enable-usermedia-screen-capturing",
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${this.config.browser.viewportWidth},${this.config.browser.viewportHeight}`,
      "--start-maximized",
      "--no-first-run",
      "--hide-crash-restore-bubble",
      "--disable-session-crashed-bubble",
      "--disable-dev-shm-usage",
      "--disable-features=AudioServiceSandbox",
      "--force-device-scale-factor=1",
      "--high-dpi-support=1",
      `--auto-select-desktop-capture-source=${this.config.browser.desktopCaptureSource}`,
      `--auto-select-tab-capture-source-by-title=${this.config.browser.stageTitle}`
    ];

    if (this.config.browser.productUrl.startsWith("http://")) {
      args.push("--allow-http-screen-capture");
      args.push(`--unsafely-treat-insecure-origin-as-secure=${this.config.browser.productUrl}`);
    }

    return args;
  }

  async grantMeetPermissions() {
    try {
      await this.context.grantPermissions(["microphone", "camera"], {
        origin: "https://meet.google.com"
      });
    } catch {
      this.logger.warn("Could not pre-grant Meet media permissions. Chrome may ask once in the UI.");
    }
  }

  async openProduct() {
    if (!this.context) await this.launch();
    this.productPage = await this.context.newPage();
    await this.productPage.setViewportSize({
      width: this.config.browser.viewportWidth,
      height: this.config.browser.viewportHeight
    });
    await this.productPage.goto(this.config.browser.productUrl, { waitUntil: "domcontentloaded" });
    await this.prepareProductStage();
    return this.productPage;
  }

  async prepareProductStage() {
    if (!this.productPage) return;

    await this.productPage.evaluate((stageTitle) => {
      document.title = stageTitle;
      window.name = stageTitle;
      document.documentElement.dataset.aiDemoStage = "true";
    }, this.config.browser.stageTitle);

    this.logger.info(`Product stage ready: ${this.config.browser.stageTitle}`);
  }

  async authenticate() {
    if (!this.context) await this.launch();
    const page = await this.context.newPage();
    await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });
    this.logger.info("Google sign-in browser is open. Complete login manually, then close the window.");
  }

  async joinMeet({ autoPresent = this.config.browser.autoPresent } = {}) {
    if (!this.config.browser.meetUrl) {
      throw new Error("GOOGLE_MEET_URL is required for Meet mode.");
    }

    if (!this.context) await this.launch();
    this.meetPage = await this.context.newPage();
    await this.meetPage.goto(this.config.browser.meetUrl, { waitUntil: "domcontentloaded" });
    await this.meetPage.waitForTimeout(1500);
    await this.logMediaDeviceDiagnostics("loaded");
    await this.saveMeetDiagnostics("loaded");

    await this.enterMeetingCodeFromHomeIfNeeded();
    await this.dismissPrejoinToggles();
    await this.ensureMicrophoneUnmuted("prejoin");
    await this.fillDisplayNameIfNeeded();
    const joined = (await this.isInMeetRoom()) || (await this.clickJoinButton());
    if (!joined) {
      await this.saveMeetDiagnostics("join-not-confirmed");
      throw new Error(
        "Meet join was not confirmed. The agent may need to be admitted by the host or signed in with an invited Google account."
      );
    }

    await this.logMediaDeviceDiagnostics("joined");
    await this.ensureMicrophoneUnmuted("joined");
    await this.saveMeetDiagnostics("joined");

    if (autoPresent) {
      await this.tryStartPresenting();
    } else {
      this.logger.warn(
        "Auto-present is disabled. Start screen sharing manually if Meet requires it, then choose the product browser/window."
      );
    }

    return this.meetPage;
  }

  extractMeetCode() {
    try {
      const url = new URL(this.config.browser.meetUrl);
      const pathCode = url.pathname
        .split("/")
        .map((part) => part.trim())
        .find((part) => /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(part));

      if (pathCode) return pathCode;
    } catch {
      // Fall through to the raw string parser.
    }

    const match = this.config.browser.meetUrl.match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
    return match ? match[0] : "";
  }

  async enterMeetingCodeFromHomeIfNeeded() {
    const currentUrl = this.meetPage.url();
    const isMeetHome =
      /workspace\.google\.com\/products\/meet/i.test(currentUrl) ||
      (await this.meetPage
        .getByText(/join a meeting now/i)
        .first()
        .isVisible({ timeout: 2500 })
        .catch(() => false));

    if (!isMeetHome) return;

    const meetCode = this.extractMeetCode();
    if (!meetCode) {
      this.logger.warn("Meet opened the home page, but no meeting code could be extracted from the URL.");
      return;
    }

    this.logger.warn("Meet link opened the home page. Entering the meeting code manually.");

    const enterCodeTriggers = [
      this.meetPage.getByRole("link", { name: /enter code/i }).first(),
      this.meetPage.getByRole("button", { name: /enter code/i }).first(),
      this.meetPage.getByText(/enter code/i).first()
    ];

    for (const trigger of enterCodeTriggers) {
      try {
        await trigger.click({ timeout: 4000 });
        break;
      } catch {
        // Try next Meet home-page variant.
      }
    }

    const codeInputs = [
      this.meetPage.locator("input[aria-label*='meeting code' i]").first(),
      this.meetPage.locator("input[placeholder*='meeting code' i]").first(),
      this.meetPage.locator("input[type='text']").first()
    ];

    let filled = false;
    for (const input of codeInputs) {
      try {
        await input.fill(meetCode, { timeout: 5000 });
        filled = true;
        break;
      } catch {
        // Try next input selector.
      }
    }

    if (!filled) {
      this.logger.warn("Meet home-page meeting code input was not found.");
      return;
    }

    const joinButtons = [
      this.meetPage.getByRole("button", { name: /^join$/i }).first(),
      this.meetPage.getByRole("button", { name: /join/i }).first()
    ];

    for (const button of joinButtons) {
      try {
        await button.click({ timeout: 5000 });
        await this.meetPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        return;
      } catch {
        // The field also accepts Enter.
      }
    }

    await this.meetPage.keyboard.press("Enter").catch(() => {});
  }

  async dismissPrejoinToggles() {
    const labels = [
      /turn off camera/i
    ];

    for (const label of labels) {
      const button = this.meetPage.getByRole("button", { name: label }).first();
      try {
        await button.click({ timeout: 2000 });
      } catch {
        // Google Meet labels vary by account, locale, and state.
      }
    }
  }

  async ensureMicrophoneUnmuted(stage = "meet") {
    const alreadyOnButtons = [
      this.meetPage.getByRole("button", { name: /turn off microphone/i }).first(),
      this.meetPage.getByRole("button", { name: /^mute$/i }).first(),
      this.meetPage.getByRole("button", { name: /microphone.*on/i }).first(),
      this.meetPage.locator("button[aria-label*='Turn off microphone' i]").first()
    ];

    for (const button of alreadyOnButtons) {
      try {
        if (await button.isVisible({ timeout: 1200 })) {
          this.logger.info(`Meet microphone already appears unmuted at ${stage}.`);
          return true;
        }
      } catch {
        // Try next Meet label variant.
      }
    }

    const buttons = [
      this.meetPage.getByRole("button", { name: /turn on microphone/i }).first(),
      this.meetPage.getByRole("button", { name: /unmute/i }).first(),
      this.meetPage.getByRole("button", { name: /microphone.*off/i }).first(),
      this.meetPage.locator("button[aria-label*='Turn on microphone' i]").first()
    ];

    for (const button of buttons) {
      try {
        if (await button.isVisible({ timeout: 2000 })) {
          await button.click({ timeout: 3000 });
          this.logger.info(`Clicked Meet microphone unmute control at ${stage}.`);
          await this.meetPage.waitForTimeout(500);
          return true;
        }
      } catch {
        // Try next Meet label variant.
      }
    }

    await this.saveMeetDiagnostics(`mic-control-not-found-${stage}`);
    return false;
  }

  async fillDisplayNameIfNeeded() {
    const input = this.meetPage
      .locator("input[aria-label*='name' i], input[placeholder*='name' i]")
      .first();

    try {
      if (await input.isVisible({ timeout: 3000 })) {
        await input.fill(this.config.browser.meetDisplayName);
      }
    } catch {
      // Signed-in users usually do not see the guest display-name field.
    }
  }

  async clickJoinButton() {
    if (await this.isInMeetRoom()) {
      this.logger.info("Meet room controls are already visible; treating the agent as joined.");
      return true;
    }

    const candidates = [
      this.meetPage.getByRole("button", { name: /^ask to join$/i }).first(),
      this.meetPage.getByRole("button", { name: /^join now$/i }).first(),
      this.meetPage.getByRole("button", { name: /^join$/i }).first(),
      this.meetPage.getByRole("button", { name: /ask to join|join now|join/i }).first(),
      this.meetPage.locator("button").filter({ hasText: /^Ask to join$/i }).first(),
      this.meetPage.locator("button").filter({ hasText: /^Join now$/i }).first(),
      this.meetPage.locator("button").filter({ hasText: /^Join$/i }).first()
    ];

    for (const button of candidates) {
      try {
        const label = await button
          .evaluate((element) =>
            [
              element.getAttribute("aria-label"),
              element.getAttribute("data-tooltip"),
              element.textContent
            ]
              .filter(Boolean)
              .join(" ")
          )
          .catch(() => "");
        if (/companion/i.test(label || "")) continue;
        await button.click({ timeout: 5000 });
        this.logger.info(`Clicked Meet join button${label ? `: ${label.trim()}` : "."}`);
        await this.saveMeetDiagnostics("join-clicked");
        return await this.waitForMeetRoom();
      } catch {
        // Try next candidate.
      }
    }

    if (await this.waitForMeetRoom({ timeoutMs: 5000, quiet: true })) {
      this.logger.info("Meet room controls became visible after navigation; treating the agent as joined.");
      return true;
    }

    await this.logMeetButtonLabels();
    this.logger.warn("Could not find a stable Meet join button. The browser remains open for manual join.");
    return false;
  }

  async isInMeetRoom() {
    await this.revealMeetControls();

    const roomControls = [
      this.meetPage.getByRole("button", { name: /leave call/i }).first(),
      this.meetPage.getByRole("button", { name: /chat with everyone/i }).first(),
      this.meetPage.getByRole("button", { name: /more activities in this meeting/i }).first(),
      this.meetPage.getByRole("button", { name: /meeting details/i }).first(),
      this.meetPage.locator("button[aria-label*='Leave call' i]").first(),
      this.meetPage.locator("button[aria-label*='Chat with everyone' i]").first(),
      this.meetPage.locator("button[aria-label*='More activities in this meeting' i]").first(),
      this.meetPage.locator("button[aria-label*='Meeting details' i]").first()
    ];

    for (const control of roomControls) {
      if (await control.isVisible({ timeout: 250 }).catch(() => false)) {
        return true;
      }
    }

    return false;
  }

  async revealMeetControls() {
    try {
      await this.meetPage.mouse.move(
        Math.round(this.config.browser.viewportWidth / 2),
        this.config.browser.viewportHeight - 80
      );
      await this.meetPage.waitForTimeout(100);
    } catch {
      // If pointer movement fails, the visibility checks below are still safe.
    }
  }

  async getRemoteAudioState() {
    if (!this.meetPage || this.meetPage.isClosed()) {
      return {
        hasMeetPage: false,
        remoteParticipantCount: 0,
        remoteUnmuted: true,
        reason: "no Meet page available"
      };
    }

    const selfNames = [
      this.config.browser.meetDisplayName,
      this.config.agent?.name,
      "Ai Agent",
      "AI Agent"
    ]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());

    await this.revealMeetControls();

    return this.meetPage.evaluate(({ selfNames }) => {
      const visibleText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const isSelfLabel = (label) => {
        const lower = label.toLowerCase();
        return selfNames.some((name) => name && lower.includes(name));
      };

      const pageText = visibleText(document.body?.innerText || "");
      const labels = Array.from(document.querySelectorAll("[aria-label], [data-tooltip], [title]"))
        .filter(isVisible)
        .map((element) =>
          visibleText(
            [
              element.getAttribute("aria-label"),
              element.getAttribute("data-tooltip"),
              element.getAttribute("title"),
              element.textContent
            ]
              .filter(Boolean)
              .join(" ")
          )
        )
        .filter(Boolean);

      const participantMatch =
        labels.join(" ").match(/\bpeople\s+(\d+)\b/i) ||
        pageText.match(/\bpeople\s+(\d+)\b/i) ||
        pageText.match(/\bparticipants?\s+(\d+)\b/i);
      const participantCount = participantMatch ? Number(participantMatch[1]) : 0;
      const remoteParticipantCount = Math.max(0, participantCount - 1);

      const remoteLabels = labels.filter((label) => !isSelfLabel(label));
      const remoteMutedLabels = remoteLabels.filter((label) =>
        /\b(is muted|muted|microphone is off|mic is off|audio is off)\b/i.test(label)
      );
      const remoteUnmutedLabels = remoteLabels.filter((label) =>
        /\b(is unmuted|unmuted|microphone is on|mic is on|speaking)\b/i.test(label)
      );

      if (remoteUnmutedLabels.length > 0) {
        return {
          hasMeetPage: true,
          remoteParticipantCount,
          remoteUnmuted: true,
          reason: `remote unmuted marker: ${remoteUnmutedLabels[0].slice(0, 120)}`
        };
      }

      if (remoteParticipantCount > 0 && remoteMutedLabels.length >= remoteParticipantCount) {
        return {
          hasMeetPage: true,
          remoteParticipantCount,
          remoteUnmuted: false,
          reason: `all ${remoteParticipantCount} remote participant(s) appear muted`
        };
      }

      return {
        hasMeetPage: true,
        remoteParticipantCount,
        remoteUnmuted: remoteParticipantCount > 0,
        reason:
          remoteParticipantCount > 0
            ? "remote mute state not explicit; accepting non-silent Meet output"
            : "no remote participant detected"
      };
    }, { selfNames });
  }

  async waitForMeetRoom({ timeoutMs = 60000, quiet = false } = {}) {
    const markers = [
      this.meetPage.getByRole("button", { name: /leave call|leave/i }).first(),
      this.meetPage.getByRole("button", { name: /chat with everyone/i }).first(),
      this.meetPage.getByRole("button", { name: /more activities in this meeting/i }).first(),
      this.meetPage.getByRole("button", { name: /meeting details/i }).first(),
      this.meetPage.getByText(/you are in the meeting/i).first()
    ];

    const blockedMarkers = [
      this.meetPage.getByText(/you can['’]t join this video call/i).first(),
      this.meetPage.getByText(/returning to home screen/i).first(),
      this.meetPage.getByText(/no one can join a meeting unless invited or admitted by the host/i).first(),
      this.meetPage.getByText(/you['’]re in companion mode/i).first(),
      this.meetPage.getByText(/speakers and mic are unavailable/i).first()
    ];

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await this.revealMeetControls();
      await this.dismissMeetNotice();

      for (const blockedMarker of blockedMarkers) {
        if (await blockedMarker.isVisible({ timeout: 250 }).catch(() => false)) {
          const text = await blockedMarker.textContent().catch(() => "");
          if (/companion mode|mic are unavailable/i.test(text || "")) {
            throw new Error(
              "Meet joined in Companion mode, where microphone and speaker are disabled. The agent must join with the normal 'Join now' button."
            );
          }

          throw new Error(
            "Meet rejected the agent before it entered the room. Invite the signed-in bot account or admit the guest from the host account."
          );
        }
      }

      for (const marker of markers) {
        if (await marker.isVisible({ timeout: 250 }).catch(() => false)) {
          return true;
        }
      }

      await this.meetPage.waitForTimeout(1000);
    }

    if (!quiet) {
      this.logger.warn("Meet room confirmation was not detected. If the agent is waiting to be admitted, admit it in Meet.");
    }
    return false;
  }

  async dismissMeetNotice() {
    const notices = [
      this.meetPage.getByRole("button", { name: /^got it$/i }).first(),
      this.meetPage.getByRole("button", { name: /^continue$/i }).first(),
      this.meetPage.getByRole("button", { name: /^dismiss$/i }).first(),
      this.meetPage.getByRole("button", { name: /^ok$/i }).first(),
      this.meetPage.locator("button").filter({ hasText: /^Got it$/i }).first(),
      this.meetPage.locator("button").filter({ hasText: /^Continue$/i }).first(),
      this.meetPage.locator("button").filter({ hasText: /^Dismiss$/i }).first(),
      this.meetPage.locator("button").filter({ hasText: /^OK$/i }).first()
    ];

    for (const notice of notices) {
      try {
        if (await notice.isVisible({ timeout: 250 })) {
          await notice.click({ timeout: 1000 });
          this.logger.info("Dismissed Meet notice dialog.");
          await this.meetPage.waitForTimeout(500);
          return true;
        }
      } catch {
        // Try next notice variant.
      }
    }

    const clickedLabel = await this.meetPage
      .evaluate(() => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const allowedLabels = new Set(["got it", "continue", "dismiss", "ok"]);
        const buttons = Array.from(document.querySelectorAll("button,[role='button']"));
        for (const button of buttons) {
          const label = [
            button.getAttribute("aria-label"),
            button.getAttribute("data-tooltip"),
            button.getAttribute("title"),
            button.textContent
          ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (isVisible(button) && allowedLabels.has(label.toLowerCase())) {
            button.click();
            return label;
          }
        }
        return "";
      })
      .catch(() => "");

    if (clickedLabel) {
      this.logger.info(`Dismissed Meet notice dialog through DOM fallback: ${clickedLabel}.`);
      await this.meetPage.waitForTimeout(500);
      return true;
    }

    return false;
  }

  async tryStartPresenting() {
    if (this.productPage) {
      await this.prepareProductStage();
    }

    await this.revealMeetControls();
    const buttons = [
      this.meetPage.getByRole("button", { name: /present now/i }).first(),
      this.meetPage.getByRole("button", { name: /present/i }).first(),
      this.meetPage.getByRole("button", { name: /share screen|share/i }).first(),
      this.meetPage.locator("button[aria-label*='Present' i]").first(),
      this.meetPage.locator("button[aria-label*='Share' i]").first()
    ];

    for (const button of buttons) {
      try {
        await button.click({ timeout: 5000 });
        await this.meetPage.waitForTimeout(1000);

        await this.choosePresentationSourceType();

        if (this.productPage) {
          await this.productPage.bringToFront();
        }

        this.logger.info("Attempted to start Meet presentation.");
        return await this.waitForPresentationStarted();
      } catch {
        // Try next candidate.
      }
    }

    const clickedFallback = await this.clickPresentControlFromDom();
    if (clickedFallback) {
      await this.choosePresentationSourceType();
      if (this.productPage) {
        await this.productPage.bringToFront();
      }
      this.logger.info("Attempted to start Meet presentation through DOM fallback.");
      return await this.waitForPresentationStarted();
    }

    await this.logMeetButtonLabels();
    await this.saveMeetDiagnostics("present-control-not-found");
    this.logger.warn("Auto-present did not find the Meet presentation controls.");
    return false;
  }

  async waitForPresentationStarted({ timeoutMs = 12000 } = {}) {
    const markers = [
      this.meetPage.getByRole("button", { name: /stop presenting|stop sharing/i }).first(),
      this.meetPage.locator("button[aria-label*='Stop presenting' i]").first(),
      this.meetPage.locator("button[aria-label*='Stop sharing' i]").first(),
      this.meetPage.getByText(/you are presenting|you're presenting|presenting now/i).first()
    ];

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await this.revealMeetControls();
      for (const marker of markers) {
        if (await marker.isVisible({ timeout: 300 }).catch(() => false)) {
          this.logger.info("Meet presentation is confirmed active.");
          await this.saveMeetDiagnostics("presenting");
          return true;
        }
      }
      await this.meetPage.waitForTimeout(800);
    }

    await this.logMeetButtonLabels();
    await this.saveMeetDiagnostics("present-not-confirmed");
    this.logger.warn(
      "Meet presentation was not confirmed. Chrome may still be waiting in the native screen picker, or the capture-source label did not match."
    );
    return false;
  }

  async clickPresentControlFromDom() {
    return await this.meetPage.evaluate(() => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const buttons = Array.from(document.querySelectorAll("button,[role='button']"));
      const candidate = buttons.find((button) => {
        const label = [
          button.getAttribute("aria-label"),
          button.getAttribute("data-tooltip"),
          button.getAttribute("jsname"),
          button.textContent
        ]
          .filter(Boolean)
          .join(" ");

        return isVisible(button) && /present|share screen|share|screen/i.test(label);
      });

      if (!candidate) return false;
      candidate.click();
      return true;
    });
  }

  async logMeetButtonLabels() {
    const labels = await this.getMeetButtonLabels();

    this.logger.warn(`Visible Meet button labels: ${JSON.stringify(labels)}`);
  }

  async getMeetButtonLabels() {
    if (!this.meetPage || this.meetPage.isClosed()) return [];

    return this.meetPage
      .evaluate(() => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        return Array.from(document.querySelectorAll("button,[role='button']"))
          .filter(isVisible)
          .map((button) => ({
            text: (button.textContent || "").trim(),
            aria: button.getAttribute("aria-label") || "",
            tooltip: button.getAttribute("data-tooltip") || "",
            title: button.getAttribute("title") || ""
          }))
          .filter((item) => item.text || item.aria || item.tooltip || item.title)
          .slice(0, 100);
      })
      .catch(() => []);
  }

  async logMediaDeviceDiagnostics(stage = "meet") {
    const diagnostics = await this.getMediaDeviceDiagnostics();
    this.logger.info(`Meet media diagnostics at ${stage}: ${JSON.stringify(diagnostics)}`);
    return diagnostics;
  }

  async getMediaDeviceDiagnostics() {
    if (!this.meetPage || this.meetPage.isClosed()) {
      return { hasMeetPage: false };
    }

    return this.meetPage
      .evaluate(async () => {
        const result = {
          hasMeetPage: true,
          secureContext: window.isSecureContext,
          hasMediaDevices: Boolean(navigator.mediaDevices),
          getUserMedia: {
            ok: false,
            error: "",
            tracks: []
          },
          devices: []
        };

        if (!navigator.mediaDevices) return result;

        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          result.getUserMedia.ok = true;
          result.getUserMedia.tracks = stream.getTracks().map((track) => ({
            kind: track.kind,
            label: track.label,
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState
          }));
          for (const track of stream.getTracks()) track.stop();
        } catch (error) {
          result.getUserMedia.error = `${error.name || "Error"}: ${error.message || ""}`.trim();
        }

        try {
          result.devices = (await navigator.mediaDevices.enumerateDevices()).map((device) => ({
            kind: device.kind,
            label: device.label,
            hasDeviceId: Boolean(device.deviceId),
            hasGroupId: Boolean(device.groupId)
          }));
        } catch (error) {
          result.enumerateDevicesError = `${error.name || "Error"}: ${error.message || ""}`.trim();
        }

        return result;
      })
      .catch((error) => ({
        hasMeetPage: true,
        error: error.message
      }));
  }

  async saveMeetDiagnostics(stage) {
    if (!this.config.browser.saveDiagnostics || !this.config.paths.meetDiagnosticsDir) {
      return null;
    }

    if (!this.meetPage || this.meetPage.isClosed()) {
      return null;
    }

    const index = String(++this.diagnosticIndex).padStart(3, "0");
    const safeStage = String(stage || "meet")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const dir = this.config.paths.meetDiagnosticsDir;
    fs.mkdirSync(dir, { recursive: true });

    const basePath = path.join(dir, `${index}-${safeStage || "meet"}`);
    const screenshotPath = `${basePath}.png`;
    const jsonPath = `${basePath}.json`;
    const diagnostics = {
      stage,
      at: new Date().toISOString(),
      url: this.meetPage.url(),
      title: await this.meetPage.title().catch(() => ""),
      viewport: {
        width: this.config.browser.viewportWidth,
        height: this.config.browser.viewportHeight
      },
      browser: {
        channel: this.config.browser.channel || "playwright-default",
        desktopCaptureSource: this.config.browser.desktopCaptureSource,
        stageTitle: this.config.browser.stageTitle
      },
      media: await this.getMediaDeviceDiagnostics(),
      buttons: await this.getMeetButtonLabels()
    };

    await this.meetPage.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    fs.writeFileSync(jsonPath, JSON.stringify(diagnostics, null, 2));
    this.logger.info(`Saved Meet diagnostics for '${stage}' to ${jsonPath} and ${screenshotPath}.`);

    return { jsonPath, screenshotPath };
  }

  async choosePresentationSourceType() {
    const sourcePrefersScreen = /entire screen|screen 1|screen/i.test(
      this.config.browser.desktopCaptureSource || ""
    );
    const screenCandidates = [
      this.meetPage.getByText(/entire screen|your entire screen/i).first(),
      this.meetPage.locator("[role='menuitem'], [role='option'], button").filter({ hasText: /screen/i }).first()
    ];
    const tabCandidates = [
      this.meetPage.getByText(/a tab|chrome tab|browser tab/i).first(),
      this.meetPage.locator("[role='menuitem'], [role='option'], button").filter({ hasText: /tab/i }).first()
    ];
    const windowCandidates = [
      this.meetPage.getByText(/window/i).first(),
      this.meetPage.locator("[role='menuitem'], [role='option'], button").filter({ hasText: /window/i }).first()
    ];

    const candidates = sourcePrefersScreen
      ? [...screenCandidates, ...tabCandidates, ...windowCandidates]
      : [...tabCandidates, ...windowCandidates, ...screenCandidates];

    for (const candidate of candidates) {
      try {
        await candidate.click({ timeout: 3500 });
        this.logger.info(
          `Selected Meet presentation source type for '${this.config.browser.desktopCaptureSource}'.`
        );
        return;
      } catch {
        // Browser and Meet versions expose this differently.
      }
    }
  }

  async close() {
    if (this.context) {
      await this.context.close();
    }
  }
}
