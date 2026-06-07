/**
 * test-linkpays.js
 *
 * Tests the full LinkPays earn flow using puppeteer-real-browser
 * (bypasses Cloudflare Turnstile) + Xvfb for virtual display.
 *
 * Full chain:
 *   /earn → click "Open LinkPays"
 *     → POST /earn/linkpays/start → 302 → linkpays.in/VEKTALNODES_COINS (MAIN TAB)
 *     → proceed() fires after 3.5s → ad site (evspec.in / rank1st.in)
 *     → 4 ad pages (countdown + I'm Not Robot + Verify + Continue each)
 *     → bookyourhotel.in → wait 30s → Get Link
 *     → linkpays.in/VEKTALNODES_COINS → vektalnodes.in/earn/linkpays/complete?token=...
 *     → 12 coins credited ✅
 */

require("dotenv").config();
const { connect } = require("puppeteer-real-browser");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SITE = "https://vektalnodes.in";
const EMAIL = process.env.EMAIL || process.env.VEKTAL_EMAIL || "";
const PASSWORD = process.env.PASSWORD || process.env.VEKTAL_PASSWORD || "";
const DISPLAY_NUM = ":94";
const XVFB_PATH = "/usr/bin/Xvfb";

if (!EMAIL || !PASSWORD) {
  console.error("ERROR: EMAIL and PASSWORD must be set in .env");
  process.exit(1);
}

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function ts() { return new Date().toLocaleTimeString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
async function sleep(ms, label) {
  if (label) log(`  ⏳ Waiting ${Math.round(ms / 1000)}s — ${label}...`);
  return new Promise((r) => setTimeout(r, ms));
}

let stepNum = 0;
async function shot(page, label) {
  stepNum++;
  const file = path.join(SCREENSHOTS_DIR, `${String(stepNum).padStart(2, "0")}-${label}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); log(`  📸 ${path.basename(file)}`); } catch {}
}

function findChrome() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/local/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`); return p; } catch {}
  }
  for (const cmd of ["google-chrome-stable", "google-chrome", "chromium"]) {
    try {
      const p = execSync(`which ${cmd} 2>/dev/null`).toString().trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

function isSnapChromium(chromePath) {
  if (!chromePath) return false;
  if (chromePath.includes("/snap/")) return true;
  try {
    const resolved = execSync(`readlink -f "${chromePath}" 2>/dev/null || echo ""`).toString().trim();
    if (resolved.includes("/snap/")) return true;
    const head = execSync(`head -5 "${chromePath}" 2>/dev/null || echo ""`).toString();
    return head.includes("/snap/");
  } catch { return false; }
}

function startXvfb() {
  if (process.env.DISPLAY) {
    log(`[Xvfb] DISPLAY already set to ${process.env.DISPLAY} — skipping.`);
    return Promise.resolve(null);
  }
  if (!fs.existsSync(XVFB_PATH)) {
    log("[Xvfb] Not found at /usr/bin/Xvfb — run: sudo apt-get install -y xvfb");
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    log(`[Xvfb] Starting on display ${DISPLAY_NUM}...`);
    const xvfb = spawn(XVFB_PATH, [DISPLAY_NUM, "-screen", "0", "1280x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"], {
      stdio: ["ignore", "ignore", "pipe"], detached: false,
    });
    xvfb.on("error", (err) => {
      log(`[Xvfb] ERROR: ${err.message}`);
      reject(err);
    });
    setTimeout(() => resolve(xvfb), 2000);
  });
}

async function waitForCF(page, ms = 90000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const title = await page.title().catch(() => "");
    const url = page.url();
    if (!title.toLowerCase().includes("just a moment") && !url.includes("cdn-cgi/challenge")) return;
    log(`  [CF] Cloudflare challenge active — waiting...`);
    await sleep(2000);
  }
  log("  [CF] Warning: challenge may not have cleared.");
}

async function waitForUrl(page, matches, timeoutMs = 60000, label = "") {
  const dl = Date.now() + timeoutMs;
  let prev = "";
  while (Date.now() < dl) {
    const u = page.url();
    if (u !== prev) { log(`  ${label ? "[" + label + "] " : ""}URL → ${u}`); prev = u; }
    if (matches.some((m) => u.includes(m))) return u;
    await sleep(800);
  }
  throw new Error(`Timeout waiting for [${matches.join(", ")}]. Current: ${page.url()}`);
}

async function readCountdown(page) {
  return page.evaluate(() => {
    const doc = document;
    const candidates = [
      doc.querySelector("#timer"), doc.querySelector("#countdown"),
      doc.querySelector(".timer"), doc.querySelector(".countdown"),
      doc.querySelector("[id*='timer']"), doc.querySelector("[id*='count']"),
      doc.querySelector("[class*='timer']"), doc.querySelector("[class*='count']"),
    ];
    for (const el of candidates) {
      if (!el) continue;
      const n = parseInt((el.innerText || el.textContent || "").trim(), 10);
      if (!isNaN(n) && n >= 0) return n;
    }
    return 0;
  }).catch(() => 0);
}

async function waitForCountdown(page, maxMs = 45000, label = "", minMs = 15000) {
  const prefix = label ? `[${label}] ` : "";
  await sleep(1500);
  const dl = Date.now() + maxMs;
  const minDl = Date.now() + minMs;
  let last = -1;
  let seen = false;
  while (Date.now() < dl) {
    const secs = await readCountdown(page);
    if (secs !== last) { log(`  ${prefix}Countdown: ${secs}s`); last = secs; }
    if (secs > 0) seen = true;
    if (secs <= 0 && Date.now() >= minDl) return;
    await sleep(1000);
  }
  if (!seen) log(`  ${prefix}No countdown found — used ${minMs / 1000}s floor.`);
}

async function clickButton(page, selectors, textMatches, label = "") {
  const result = await page.evaluate(
    (sels, texts) => {
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel);
          if (el && !el.disabled) { el.click(); return sel; }
        } catch {}
      }
      const clickables = Array.from(document.querySelectorAll("button, a, input[type=submit], [role=button]"));
      for (const el of clickables) {
        const text = (el.innerText || el.value || "").toLowerCase();
        if (texts.some((t) => text.includes(t.toLowerCase()))) {
          if (!el.disabled) { el.click(); return "text:" + el.innerText.trim().slice(0, 40); }
        }
      }
      return null;
    },
    selectors,
    textMatches,
  ).catch(() => null);
  if (result) log(`  ✓ Clicked ${label} (${result})`);
  else log(`  ✗ ${label} not found`);
  return !!result;
}

async function handleAdPage(page, label) {
  log(`\n── Ad page [${label}] — ${page.url()} ──`);
  await shot(page, `ad-${label}-start`);

  // Wait for countdown timer (15s minimum)
  await waitForCountdown(page, 35000, label, 15000);
  await shot(page, `ad-${label}-after-countdown`);

  // Scroll to reveal any hidden buttons
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(800);

  // Click "I'm Not Robot" if it appears
  const notRobot = await clickButton(page, ["button.tp-unlock-btn", ".tp-unlock-btn"], ["not robot", "i'm not", "human"], "I'm Not Robot");
  if (notRobot) await sleep(2000);

  // Scroll again
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(600);
  await shot(page, `ad-${label}-pre-verify`);

  // Click Verify button
  const verified = await clickButton(page, ["button.tp-btn.tp-blue", "button.tp-btn"], ["verify", "verifiy"], "Verify");
  if (verified) await sleep(1500);

  // Click Continue button
  await clickButton(page, ["button.tp-btn.tp-blue", "button.tp-btn", ".tp-btn"], ["continue", "next", "proceed"], "Continue");
  await sleep(3000);

  log(`  → After ad page: ${page.url()}`);
  await shot(page, `ad-${label}-done`);
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const startTime = Date.now();
  log("=== LinkPays Test (puppeteer-real-browser) ===");

  const chrome = findChrome();
  if (!chrome) { log("ERROR: No Chrome/Chromium found. Run start.sh to install."); process.exit(1); }
  const snap = isSnapChromium(chrome);
  log(`Chrome: ${chrome} (snap: ${snap})`);

  // Start Xvfb for virtual display
  const xvfb = await startXvfb().catch((e) => { log(`Xvfb failed: ${e.message} — continuing without`); return null; });
  if (!process.env.DISPLAY && xvfb) process.env.DISPLAY = DISPLAY_NUM;
  log(`DISPLAY=${process.env.DISPLAY || "(none)"}`);

  const commonArgs = [
    "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer",
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    "--no-sandbox", "--disable-setuid-sandbox",
  ];
  const launcherDefaults = [
    "--disable-background-networking", "--disable-client-side-phishing-detection",
    "--disable-default-apps", "--disable-extensions", "--disable-hang-monitor",
    "--disable-popup-blocking", "--disable-prompt-on-repost", "--disable-sync",
    "--metrics-recording-only", "--safebrowsing-disable-auto-update",
    "--password-store=basic", "--use-mock-keychain",
    "--disable-features=Translate,BackForwardCache,AutomationControlled",
  ];
  const connectArgs = snap
    ? [...launcherDefaults, ...commonArgs]
    : [...commonArgs];

  let browser, page;
  const cleanup = () => {
    try { browser?.close(); } catch {}
    if (xvfb) { try { xvfb.kill("SIGTERM"); } catch {} }
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  try {
    log("Launching browser (puppeteer-real-browser)...");
    const result = await connect({
      headless: false,
      args: connectArgs,
      customConfig: { chromePath: chrome },
      turnstile: true,
      connectOption: { defaultViewport: { width: 1280, height: 900 } },
      disableXvfb: true,
      ignoreAllFlags: snap,
    });
    browser = result.browser;
    page = result.page;
    page.setDefaultNavigationTimeout(90000);
    page.on("dialog", async (d) => { log(`Dialog: ${d.message()}`); await d.dismiss(); });
    log("Browser launched ✓");

    // ── STEP 1: Login ──────────────────────────────────────────────────────
    log("\n── STEP 1: Login ──");
    await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCF(page, 60000);
    await sleep(1000);

    await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCF(page);
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 }).catch(() => {});
    await sleep(600);

    let emailEl = await page.$('input[type="email"], input[name="email"]');
    if (!emailEl) {
      log("Email input not found — reloading...");
      await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForCF(page);
      await sleep(800);
      emailEl = await page.$('input[type="email"], input[name="email"]');
    }
    if (!emailEl) throw new Error("No email input found on login page");

    await emailEl.click({ clickCount: 3 });
    await emailEl.type(EMAIL, { delay: 55 });
    const passEl = await page.$('input[type="password"]');
    if (!passEl) throw new Error("No password input found");
    await passEl.click({ clickCount: 3 });
    await passEl.type(PASSWORD, { delay: 55 });

    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.keyboard.press("Enter"),
    ]);
    await waitForCF(page);

    if (page.url().includes("/login")) {
      await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForCF(page);
      if (page.url().includes("/login")) throw new Error("Login failed — still on /login");
    }
    log(`✓ Logged in: ${page.url()}`);
    await shot(page, "earn-page");

    // Check coins before
    const coinsBefore = await page.evaluate(() => {
      const el = document.querySelector(".topbar-pill strong");
      return el ? parseInt(el.innerText.trim(), 10) || 0 : 0;
    }).catch(() => 0);
    log(`Coins before: ${coinsBefore}`);

    // ── STEP 2: Click "Open LinkPays" ──────────────────────────────────────
    log("\n── STEP 2: Click Open LinkPays ──");
    const lpBtn = await page.$('button.button-primary[type="submit"], button.button.button-primary');
    if (!lpBtn) throw new Error("LinkPays button not found on /earn page");

    log("  Clicking button — POST /earn/linkpays/start will fire + redirect to linkpays.in...");
    await lpBtn.click();

    // MAIN TAB navigates to linkpays.in via 302 redirect
    log("  Waiting for MAIN TAB to navigate to linkpays.in...");
    let linkpaysUrl;
    try {
      linkpaysUrl = await waitForUrl(page, ["linkpays.in"], 20000, "main-tab");
    } catch {
      log(`  Current URL: ${page.url()} — did not reach linkpays.in in 20s`);
      throw new Error("Main tab did not navigate to linkpays.in after button click");
    }
    log(`  ✓ On linkpays.in: ${linkpaysUrl}`);
    await waitForCF(page, 30000);
    await sleep(1000);
    await shot(page, "linkpays-page");

    // ── STEP 3: Wait for proceed() then call it manually ──────────────────
    log("\n── STEP 3: proceed() on linkpays.in ──");

    // Decode the target URL from proceed()
    const proceedTarget = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll("script"));
      for (const s of scripts) {
        const m = (s.textContent || "").match(/atob\("([A-Za-z0-9+/=]+)"\)/);
        if (m) { try { return atob(m[1]); } catch { return ""; } }
      }
      return "";
    }).catch(() => "");
    log(`  proceed() target: ${proceedTarget || "(not found yet)"}`);

    // Wait 4s for auto-proceed, then call manually
    await sleep(4000, "auto-proceed timer");
    const proceedCalled = await page.evaluate(() => {
      if (typeof proceed === "function") { proceed(); return true; }
      return false;
    }).catch(() => false);
    log(`  proceed() manually called: ${proceedCalled}`);

    // ── STEP 4: Wait for navigation to ad site ────────────────────────────
    log("\n── STEP 4: Navigate to ad site ──");
    let adSiteUrl;
    try {
      adSiteUrl = await waitForUrl(page, ["evspec.in", "rank1st.in", "savepe.in", "bookyourhotel.in", "earn/linkpays/complete"], 30000, "ad-site");
    } catch {
      const u = page.url();
      log(`  WARNING: Still on ${u} — checking if still linkpays.in...`);
      if (u.includes("linkpays.in")) {
        // Try clicking "Continue to next step" button
        await clickButton(page, ["button.btn", "a.btn", ".btn"], ["continue", "next step"], "Continue to next step");
        await sleep(5000);
        adSiteUrl = page.url();
        log(`  After continue click: ${adSiteUrl}`);
      } else {
        adSiteUrl = u;
      }
    }
    log(`  ✓ Ad site: ${adSiteUrl}`);
    await shot(page, "ad-site-start");

    // ── STEP 5: Loop through ad pages ─────────────────────────────────────
    log("\n── STEP 5: Ad page loop ──");
    for (let i = 1; i <= 6; i++) {
      const u = page.url();
      log(`\n  [loop ${i}] URL: ${u}`);

      if (u.includes("vektalnodes.in")) {
        log("  ✓ Back on vektalnodes.in!");
        break;
      }
      if (u.includes("bookyourhotel.in")) {
        log("  → On bookyourhotel.in — jumping to gateway step");
        break;
      }
      // Google vignette auto-redirects
      if (u.includes("google_vignette") || u.includes("google.com/url")) {
        log("  Google vignette — waiting 8s for auto-redirect...");
        await sleep(8000);
        continue;
      }
      // Ad pages: rank1st.in, evspec.in, savepe.in, etc.
      const isAd = await page.evaluate(() => !!(
        document.querySelector("button.tp-unlock-btn") ||
        document.querySelector("button.tp-btn") ||
        document.querySelector(".tp-unlock-btn") ||
        document.querySelector("[class*='tp-']")
      )).catch(() => false);

      if (isAd) {
        await handleAdPage(page, `p${i}`);
      } else {
        log("  Not an ad page — waiting 6s for auto-redirect...");
        await sleep(6000);
      }
    }

    // ── STEP 6: bookyourhotel.in — Get Link ──────────────────────────────
    log("\n── STEP 6: bookyourhotel.in (final gateway) ──");
    let onHotel = false;
    for (let i = 0; i < 20; i++) {
      const u = page.url();
      if (u.includes("bookyourhotel.in")) { onHotel = true; break; }
      if (u.includes("vektalnodes.in")) { log(`  Already back on vektalnodes: ${u}`); break; }
      await sleep(1000);
    }

    if (onHotel) {
      log(`  On bookyourhotel.in: ${page.url()}`);
      await shot(page, "hotel-start");
      // Wait 30s countdown minimum
      await waitForCountdown(page, 40000, "hotel", 30000);
      await shot(page, "hotel-after-wait");

      // Click Get Link
      const gotLink = await clickButton(
        page,
        ["button.tp-btn", "#get-link", ".get-link", "a.btn"],
        ["get link", "get links", "claim", "proceed", "continue"],
        "Get Link",
      );
      await sleep(5000);
      log(`  After Get Link: ${page.url()}`);
      await shot(page, "hotel-after-get-link");
    }

    // ── STEP 7: Final — check coins ───────────────────────────────────────
    log("\n── STEP 7: Final check ──");
    const finalUrl = page.url();
    log(`  Final URL: ${finalUrl}`);
    await shot(page, "final-url");

    // Navigate to /earn to verify coins
    await sleep(3000);
    if (!page.url().includes("vektalnodes.in/earn")) {
      await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForCF(page);
    }
    await sleep(2000);

    const coinsAfter = await page.evaluate(() => {
      const el = document.querySelector(".topbar-pill strong");
      return el ? parseInt(el.innerText.trim(), 10) || 0 : 0;
    }).catch(() => 0);

    const flash = await page.evaluate(() => {
      const el = document.querySelector(".alert, .flash, [role='alert'], .notice");
      return el ? (el.textContent || el.innerText || "").trim() : "";
    }).catch(() => "");

    await shot(page, "earn-final");

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    log(`\n${"═".repeat(50)}`);
    log(`Coins BEFORE : ${coinsBefore}`);
    log(`Coins AFTER  : ${coinsAfter}`);
    log(`Diff         : +${coinsAfter - coinsBefore}`);
    log(`Flash msg    : ${flash || "(none)"}`);
    log(`Total time   : ${elapsed}s`);
    if (coinsAfter > coinsBefore) {
      log(`✅ SUCCESS — earned ${coinsAfter - coinsBefore} coins!`);
    } else {
      log(`⚠️  No coins credited yet (check flash message / cooldown)`);
    }
    log(`${"═".repeat(50)}`);
    log(`📁 Screenshots: ${SCREENSHOTS_DIR}`);

  } catch (err) {
    log(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    try {
      if (page) await shot(page, "fatal-error").catch(() => {});
    } catch {}
  } finally {
    cleanup();
  }
})();
