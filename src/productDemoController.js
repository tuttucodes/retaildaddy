import { absoluteProductUrl } from "./demoScript.js";

export class ProductDemoController {
  constructor({ page, productUrl, logger }) {
    this.page = page;
    this.productUrl = productUrl;
    this.logger = logger;
  }

  async open() {
    await this.page.goto(this.productUrl, { waitUntil: "domcontentloaded" });
    await this.page.bringToFront();
  }

  async runStep(step) {
    this.logger.info(`Demo step: ${step.title}`);
    const action = step.action || { type: "none" };

    if (action.type === "navigate") {
      const targetUrl = absoluteProductUrl(this.productUrl, action.url);
      await this.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    }

    if (action.type === "click") {
      await this.page.locator(action.selector).first().click({ timeout: action.timeoutMs || 8000 });
    }

    if (action.type === "fill") {
      await this.page.locator(action.selector).first().fill(String(action.value), {
        timeout: action.timeoutMs || 8000
      });
    }

    if (action.type === "wait") {
      await this.page.waitForTimeout(action.ms || 1000);
    }

    if (step.zoom) {
      await this.setZoom(step.zoom);
    }

    await this.showStepBanner(step.title);

    if (step.highlight) {
      await this.highlight(step.highlight);
    }

    await this.page.waitForTimeout(step.pauseMs || 1200);
  }

  async setZoom(zoom = 1) {
    const safeZoom = Math.max(0.75, Math.min(Number(zoom) || 1, 1.5));
    await this.page.evaluate((value) => {
      document.documentElement.style.zoom = String(value);
    }, safeZoom);
  }

  async highlight(selectorList) {
    await this.page.evaluate((selectors) => {
      const previous = document.querySelector("[data-ai-demo-highlight='true']");
      if (previous) {
        previous.removeAttribute("data-ai-demo-highlight");
        previous.style.outline = previous.dataset.aiDemoPreviousOutline || "";
        previous.style.boxShadow = previous.dataset.aiDemoPreviousBoxShadow || "";
        delete previous.dataset.aiDemoPreviousOutline;
        delete previous.dataset.aiDemoPreviousBoxShadow;
      }

      const selectorsToTry = selectors.split(",").map((selector) => selector.trim());
      const target = selectorsToTry.map((selector) => document.querySelector(selector)).find(Boolean);
      if (!target) return;

      target.dataset.aiDemoHighlight = "true";
      target.dataset.aiDemoPreviousOutline = target.style.outline || "";
      target.dataset.aiDemoPreviousBoxShadow = target.style.boxShadow || "";
      target.style.outline = "4px solid #10b981";
      target.style.boxShadow = "0 0 0 8px rgba(16, 185, 129, 0.22)";
      target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }, selectorList);
  }

  async showStepBanner(title) {
    await this.page.evaluate((stepTitle) => {
      const existing = document.querySelector("[data-ai-demo-banner='true']");
      if (existing) existing.remove();

      const banner = document.createElement("div");
      banner.dataset.aiDemoBanner = "true";
      banner.textContent = stepTitle;
      Object.assign(banner.style, {
        position: "fixed",
        top: "16px",
        right: "16px",
        zIndex: "2147483647",
        background: "#111827",
        color: "#ffffff",
        border: "1px solid rgba(255,255,255,0.2)",
        boxShadow: "0 12px 36px rgba(0,0,0,0.22)",
        borderRadius: "8px",
        padding: "10px 14px",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "14px",
        fontWeight: "700",
        letterSpacing: "0"
      });
      document.body.appendChild(banner);
    }, title);
  }
}
