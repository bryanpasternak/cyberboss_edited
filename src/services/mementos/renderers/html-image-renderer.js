const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

class HtmlImageRenderer {
  constructor({ browserExecutable = "", deviceScaleFactor = 2, timeoutMs = 45_000 } = {}) {
    this.browserExecutable = text(browserExecutable);
    this.deviceScaleFactor = clamp(Number(deviceScaleFactor) || 2, 1, 3);
    this.timeoutMs = clamp(Number(timeoutMs) || 45_000, 5_000, 180_000);
  }

  async renderMany(items = []) {
    if (!Array.isArray(items) || !items.length) return [];
    const browser = await chromium.launch({
      ...resolveBrowserLaunchOptions(this.browserExecutable),
      headless: true,
      timeout: this.timeoutMs,
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 900, height: 800 },
        deviceScaleFactor: this.deviceScaleFactor,
        reducedMotion: "reduce",
      });
      try {
        const results = [];
        for (const item of items) results.push(await this.renderOne(context, item));
        return results;
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }

  async renderOne(context, { html, rootSelector = "[data-render-root]" } = {}) {
    const page = await context.newPage();
    page.setDefaultTimeout(this.timeoutMs);
    try {
      await page.setContent(String(html || ""), { waitUntil: "load" });
      await page.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
        await Promise.all(Array.from(document.images).map(async (image) => {
          if (image.complete) return;
          try { await image.decode(); } catch { /* broken images are caught by template checks */ }
        }));
      });
      const root = page.locator(rootSelector).first();
      if (await root.count() !== 1) throw new Error(`HTML render root not found: ${rootSelector}`);
      const metrics = await root.evaluate((element) => {
        const fitNodes = Array.from(element.querySelectorAll("[data-text-fit]"));
        return {
          width: Math.ceil(element.getBoundingClientRect().width),
          height: Math.ceil(element.getBoundingClientRect().height),
          overflow: fitNodes.some((node) => (
            node.scrollHeight > node.clientHeight + 1
            || node.scrollWidth > node.clientWidth + 1
          )),
        };
      });
      if (!metrics.width || !metrics.height) throw new Error("HTML render root has no visible size");
      const buffer = await root.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        timeout: this.timeoutMs,
      });
      return {
        buffer,
        width: metrics.width * this.deviceScaleFactor,
        height: metrics.height * this.deviceScaleFactor,
        overflow: metrics.overflow,
      };
    } finally {
      await page.close();
    }
  }
}

function resolveBrowserLaunchOptions(explicitPath = "") {
  const executablePath = discoverBrowserExecutable(explicitPath);
  return executablePath ? { executablePath } : {};
}

function discoverBrowserExecutable(explicitPath = "") {
  const candidates = [
    explicitPath,
    process.env.CYBERBOSS_MEMENTO_BROWSER_EXECUTABLE,
    ...(process.platform === "win32" ? [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ] : process.platform === "darwin" ? [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ] : [
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ]),
  ].map(text).filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { HtmlImageRenderer, discoverBrowserExecutable };
