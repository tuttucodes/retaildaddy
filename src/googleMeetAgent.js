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
      viewport: { width: 1440, height: 960 },
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
      "--window-size=1440,960",
      "--no-first-run",
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
    await this.productPage.setViewportSize({ width: 1440, height: 960 });
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

  async joinMeet() {
    if (!this.config.browser.meetUrl) {
      throw new Error("GOOGLE_MEET_URL is required for Meet mode.");
    }

    if (!this.context) await this.launch();
    this.meetPage = await this.context.newPage();
    await this.meetPage.goto(this.config.browser.meetUrl, { waitUntil: "domcontentloaded" });

    await this.enterMeetingCodeFromHomeIfNeeded();
    await this.dismissPrejoinToggles();
    await this.fillDisplayNameIfNeeded();
    await this.clickJoinButton();

    if (this.config.browser.autoPresent) {
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
      /turn off microphone/i,
      /turn off camera/i,
      /microphone/i,
      /camera/i
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
    const candidates = [
      this.meetPage.getByRole("button", { name: /ask to join/i }).first(),
      this.meetPage.getByRole("button", { name: /join now/i }).first(),
      this.meetPage.getByRole("button", { name: /join/i }).first()
    ];

    for (const button of candidates) {
      try {
        await button.click({ timeout: 5000 });
        this.logger.info("Clicked Meet join button.");
        await this.waitForMeetRoom();
        return;
      } catch {
        // Try next candidate.
      }
    }

    this.logger.warn("Could not find a stable Meet join button. The browser remains open for manual join.");
  }

  async waitForMeetRoom() {
    const markers = [
      this.meetPage.getByRole("button", { name: /leave call|leave/i }).first(),
      this.meetPage.getByRole("button", { name: /present now|present/i }).first(),
      this.meetPage.getByText(/you are in the meeting|meeting details/i).first()
    ];

    for (const marker of markers) {
      try {
        await marker.waitFor({ timeout: 20000 });
        return;
      } catch {
        // Try next in-call marker.
      }
    }

    this.logger.warn("Meet room confirmation was not detected. If the agent is waiting to be admitted, admit it in Meet.");
  }

  async tryStartPresenting() {
    if (this.productPage) {
      await this.prepareProductStage();
    }

    const buttons = [
      this.meetPage.getByRole("button", { name: /present now/i }).first(),
      this.meetPage.getByRole("button", { name: /present/i }).first()
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

    this.logger.warn("Auto-present did not find the Meet presentation controls.");
    return false;
  }

  async choosePresentationSourceType() {
    const candidates = [
      this.meetPage.getByText(/a tab|chrome tab|browser tab/i).first(),
      this.meetPage.getByText(/window/i).first(),
      this.meetPage.getByText(/entire screen|your entire screen/i).first()
    ];

    for (const candidate of candidates) {
      try {
        await candidate.click({ timeout: 3500 });
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
