import path from "node:path";

export class GoogleMeetAgent {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.context = null;
    this.meetPage = null;
    this.productPage = null;
  }

  async launch() {
    const { chromium } = await import("playwright");
    const profileDir = path.resolve(this.config.paths.chromeProfileDir);
    const browserArgs = this.buildChromiumArgs();

    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: this.config.browser.headless,
      viewport: {
        width: this.config.browser.viewportWidth,
        height: this.config.browser.viewportHeight
      },
      args: browserArgs
    });

    this.context.setDefaultTimeout(12000);
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

    await this.enterMeetingCodeFromHomeIfNeeded();
    await this.dismissPrejoinToggles();
    await this.fillDisplayNameIfNeeded();
    const joined = (await this.isInMeetRoom()) || (await this.clickJoinButton());
    if (!joined) {
      throw new Error(
        "Meet join was not confirmed. The agent may need to be admitted by the host or signed in with an invited Google account."
      );
    }

    await this.ensureMicrophoneUnmuted();

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

  async ensureMicrophoneUnmuted() {
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
          this.logger.info("Clicked Meet microphone unmute control.");
          await this.meetPage.waitForTimeout(500);
          return true;
        }
      } catch {
        // Try next Meet label variant.
      }
    }

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
    const roomControls = [
      this.meetPage.getByRole("button", { name: /leave call/i }).first(),
      this.meetPage.getByRole("button", { name: /share screen/i }).first(),
      this.meetPage.getByRole("button", { name: /turn off microphone/i }).first(),
      this.meetPage.locator("button[aria-label*='Leave call' i]").first(),
      this.meetPage.locator("button[aria-label*='Share screen' i]").first(),
      this.meetPage.locator("button[aria-label*='Turn off microphone' i]").first()
    ];

    for (const control of roomControls) {
      if (await control.isVisible({ timeout: 250 }).catch(() => false)) {
        return true;
      }
    }

    return false;
  }

  async waitForMeetRoom({ timeoutMs = 60000, quiet = false } = {}) {
    const markers = [
      this.meetPage.getByRole("button", { name: /leave call|leave/i }).first(),
      this.meetPage.getByRole("button", { name: /share screen/i }).first(),
      this.meetPage.getByRole("button", { name: /turn off microphone/i }).first(),
      this.meetPage.getByRole("button", { name: /present now|present/i }).first(),
      this.meetPage.getByText(/you are in the meeting|meeting details/i).first(),
      this.meetPage.getByText(/camera not found/i).first(),
      this.meetPage.getByText(/microphone not found/i).first()
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

  async tryStartPresenting() {
    if (this.productPage) {
      await this.prepareProductStage();
    }

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
        return true;
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
      return true;
    }

    await this.logMeetButtonLabels();
    this.logger.warn("Auto-present did not find the Meet presentation controls.");
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
    const labels = await this.meetPage
      .evaluate(() =>
        Array.from(document.querySelectorAll("button,[role='button']"))
          .map((button) => ({
            text: (button.textContent || "").trim(),
            aria: button.getAttribute("aria-label") || "",
            tooltip: button.getAttribute("data-tooltip") || "",
            title: button.getAttribute("title") || ""
          }))
          .filter((item) => item.text || item.aria || item.tooltip || item.title)
          .slice(0, 80)
      )
      .catch(() => []);

    this.logger.warn(`Visible Meet button labels: ${JSON.stringify(labels)}`);
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
