require("dotenv").config();
const puppeteer = require("puppeteer");
const { execSync } = require("child_process");
const path = require("path");

const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--single-process",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--mute-audio",
  "--window-size=1280,800",
];

function findChrome() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
  ];
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`); return p; } catch {}
  }
  for (const cmd of ["google-chrome-stable", "google-chrome", "chromium"]) {
    try {
      const p = execSync(`which ${cmd} 2>/dev/null`).toString().trim();
      if (p && !p.includes("snap")) return p;
    } catch {}
  }
  return null;
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error("No Chrome found."); process.exit(1); }
  console.log("Using:", chrome);

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: chrome,
    args: CHROME_ARGS,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  page.setDefaultNavigationTimeout(60000);

  await page.goto("https://vektalnodes.in/earn", { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2000));

  const content = await page.content();
  if (content.includes('type="password"')) {
    console.log("Logging in...");
    const ef = await page.$('input[type="email"]');
    const pf = await page.$('input[type="password"]');
    await ef.type(process.env.EMAIL, { delay: 60 });
    await pf.type(process.env.PASSWORD, { delay: 60 });
    const btn = await page.$('button[type="submit"]');
    await btn.click();
    await new Promise((r) => setTimeout(r, 6000));
    console.log("Logged in. URL:", page.url());
  }

  await new Promise((r) => setTimeout(r, 2000));

  const screenshotPath = path.join(__dirname, "earn_screenshot.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log("Screenshot saved:", screenshotPath);

  const snippets = await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.innerText || "").trim();
      if (t.length > 0 && t.length < 120 && el.children.length === 0 && !seen.has(t)) {
        seen.add(t);
        results.push(t);
      }
    });
    return results;
  });

  console.log("\n--- Page text ---");
  snippets.forEach((s) => console.log(s));

  await browser.close();
})().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
