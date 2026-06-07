/**
 * bot.js — AFK Bot for vektalnodes.in/earn
 *
 * Runs LinkPays earn cycles (up to 10×/day, 12 coins each = 120 coins/day).
 * Flow (proven working via test-linkpays.js):
 *   /earn → Open LinkPays → linkpays.in → SECUREGATEWAY
 *   → proceed() → evspec.in / rank1st.in (4 ad pages)
 *   → bookyourhotel.in → 240s min → GET LINK → +12 coins ✅
 *
 * SLOT TRACKING (rolling 24-hour window):
 *   Each of the 10 daily slots reopens exactly 24h after it was used.
 *   e.g. used at 12:41 → available again next day at 12:41
 *        used at 06:00 → available again next day at 06:00
 *   Slot usage is persisted to slot-log.json so restarts don't lose history.
 */

require("dotenv").config();
const { connect }  = require("puppeteer-real-browser");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");
const { appendFileSync } = require("fs");

const SITE        = "https://vektalnodes.in";
const EMAIL       = process.env.EMAIL    || process.env.VEKTAL_EMAIL    || "";
const PASSWORD    = process.env.PASSWORD || process.env.VEKTAL_PASSWORD || "";
const DISPLAY_NUM = ":94";
const XVFB_PATH   = "/usr/bin/Xvfb";
const MAX_DAILY   = 10;
const MIN_FLOW_S  = 245;
const SLOT_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24 hours in ms

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Rolling slot tracker ──────────────────────────────────────────────────────
// Persists up to MAX_DAILY timestamps (one per slot use) in slot-log.json.
// Each slot reopens exactly SLOT_WINDOW_MS (24h) after it was used.

const SLOT_LOG_PATH = path.join(__dirname, "slot-log.json");

function loadSlotLog() {
  try {
    if (fs.existsSync(SLOT_LOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(SLOT_LOG_PATH, "utf8"));
      if (Array.isArray(data.slots)) return data.slots.map(Number);
    }
  } catch {}
  return [];
}

function saveSlotLog(slots) {
  try { fs.writeFileSync(SLOT_LOG_PATH, JSON.stringify({ slots }, null, 2)); } catch {}
}

/**
 * Returns only the slot timestamps that are still within the 24h window.
 * Slots older than 24h have already "expired" and are free again.
 */
function activeSlots(slots) {
  const cutoff = Date.now() - SLOT_WINDOW_MS;
  return slots.filter((t) => t > cutoff);
}

/**
 * How many slots are free right now?
 */
function freeSlotsNow(slots) {
  return MAX_DAILY - activeSlots(slots).length;
}

/**
 * Record a successful slot use (current time).
 * Trims old entries that are already outside the 24h window.
 */
function recordSlotUse(slots) {
  const updated = [...activeSlots(slots), Date.now()];
  saveSlotLog(updated);
  return updated;
}

/**
 * Returns the ms until the next slot opens (0 if a slot is free now).
 * The oldest active slot will expire first — that's when the next slot opens.
 */
function msUntilNextSlot(slots) {
  const active = activeSlots(slots);
  if (active.length < MAX_DAILY) return 0;
  const oldest = Math.min(...active);
  const opensAt = oldest + SLOT_WINDOW_MS;
  return Math.max(0, opensAt - Date.now());
}

/**
 * Log a human-readable slot status table.
 */
function logSlotStatus(slots) {
  const active = activeSlots(slots);
  log(`[Slots] ${active.length}/${MAX_DAILY} used in last 24h | ${MAX_DAILY - active.length} free now`);
  if (active.length > 0) {
    const sorted = [...active].sort((a, b) => a - b);
    sorted.forEach((t, i) => {
      const opensAt = new Date(t + SLOT_WINDOW_MS);
      log(`  Slot ${i + 1}: used at ${new Date(t).toLocaleTimeString()} → reopens at ${opensAt.toLocaleTimeString()}`);
    });
  }
}

if (!EMAIL || !PASSWORD) {
  console.error("[ERROR] EMAIL and PASSWORD must be set in .env or environment");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts() { return new Date().toLocaleTimeString(); }
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { appendFileSync("/tmp/vektal-bot.log", line + "\n"); } catch {}
}
async function sleep(ms, label) {
  if (label) log(`  ⏳ Waiting ${Math.round(ms / 1000)}s — ${label}...`);
  return new Promise((r) => setTimeout(r, ms));
}

async function safeGoto(page, url, timeout = 60000) {
  log(`  [nav] → ${url}`);
  const nav = page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch((e) => {
    log(`  [nav] goto warning: ${e.message.split("\n")[0]}`);
  });
  const hard = new Promise((r) => setTimeout(r, timeout + 3000));
  await Promise.race([nav, hard]);
  log(`  [nav] ✓ landed: ${page.url()}`);
}

let _stepNum = 0;
async function shot(page, label) {
  _stepNum++;
  const file = path.join(SCREENSHOTS_DIR, `${String(_stepNum).padStart(2, "0")}-${label}.png`);
  try {
    await Promise.race([
      page.screenshot({ path: file, fullPage: true }),
      new Promise((_, r) => setTimeout(() => r(new Error("screenshot timeout")), 12000)),
    ]);
    log(`  📸 ${path.basename(file)}`);
  } catch (e) {
    // "Internal error" means the renderer crashed — try a viewport-only screenshot as fallback
    if (e.message && e.message.includes("Internal error")) {
      log(`  📸 renderer crashed — trying viewport-only fallback...`);
      try {
        await Promise.race([
          page.screenshot({ path: file, fullPage: false }),
          new Promise((_, r) => setTimeout(() => r(new Error("screenshot timeout")), 8000)),
        ]);
        log(`  📸 ${path.basename(file)} (viewport-only)`);
        return;
      } catch (e2) {
        log(`  📸 fallback also failed (${e2.message}) — page renderer is dead, will reload`);
        try {
          await Promise.race([
            page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }),
            new Promise((r) => setTimeout(r, 33000)),
          ]);
          log(`  📸 page reloaded after renderer crash`);
        } catch {}
        return;
      }
    }
    log(`  📸 screenshot skipped (${e.message})`);
  }
}

// ── ensurePageAlive — reload if renderer crashed after a long CF wait ──────────
async function ensurePageAlive(page, url) {
  try {
    // A simple evaluate confirms the renderer is alive
    await Promise.race([
      page.evaluate(() => document.readyState),
      new Promise((_, r) => setTimeout(() => r(new Error("renderer dead")), 5000)),
    ]);
  } catch (e) {
    log(`  [health] Renderer unresponsive (${e.message}) — reloading page...`);
    try {
      const target = url || page.url();
      await Promise.race([
        page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 }),
        new Promise((r) => setTimeout(r, 48000)),
      ]);
      log(`  [health] Page reloaded ✓ — ${page.url()}`);
      await waitForCF(page, 60000);
    } catch (e2) {
      log(`  [health] Reload also failed: ${e2.message}`);
    }
  }
}
function resetStepNum() { _stepNum = 0; }

function findChrome() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
    "/usr/local/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  for (const p of candidates) { try { execSync(`test -x "${p}"`); return p; } catch {} }
  for (const cmd of ["google-chrome-stable", "google-chrome", "chromium"]) {
    try { const p = execSync(`which ${cmd} 2>/dev/null`).toString().trim(); if (p) return p; } catch {}
  }
  return null;
}

function isSnap(chromePath) {
  if (!chromePath) return false;
  if (chromePath.includes("/snap/")) return true;
  try {
    const r = execSync(`readlink -f "${chromePath}" 2>/dev/null || echo ""`).toString().trim();
    if (r.includes("/snap/")) return true;
    const h = execSync(`head -5 "${chromePath}" 2>/dev/null || echo ""`).toString();
    return h.includes("/snap/");
  } catch { return false; }
}

function isDisplayAlive(display) {
  try {
    execSync(`xdpyinfo -display ${display} > /dev/null 2>&1`);
    return true;
  } catch { return false; }
}

function killExistingXvfb(dispNum) {
  try { execSync(`pkill -f "Xvfb :${dispNum}" 2>/dev/null || true`); } catch {}
  try { execSync(`sleep 0.5`); } catch {}
  try { execSync(`rm -f /tmp/.X${dispNum}-lock /tmp/.X${dispNum}-unix`); } catch {}
}

function startXvfb() {
  const dispNum = DISPLAY_NUM.replace(":", "");

  if (process.env.DISPLAY) {
    if (isDisplayAlive(process.env.DISPLAY)) {
      log(`[Xvfb] DISPLAY=${process.env.DISPLAY} is active — skipping.`);
      return Promise.resolve(null);
    }
    log(`[Xvfb] DISPLAY=${process.env.DISPLAY} set but not responding — killing and restarting...`);
    const existingDispNum = process.env.DISPLAY.replace(":", "");
    killExistingXvfb(existingDispNum);
    delete process.env.DISPLAY;
  }

  if (!fs.existsSync(XVFB_PATH)) {
    log("[Xvfb] Not found — run: sudo apt-get install -y xvfb");
    return Promise.resolve(null);
  }

  // Kill any existing Xvfb on our target display and remove stale locks
  killExistingXvfb(dispNum);

  return new Promise((resolve, reject) => {
    log(`[Xvfb] Starting on display ${DISPLAY_NUM}...`);
    const xvfb = spawn(XVFB_PATH,
      [DISPLAY_NUM, "-screen", "0", "1280x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
      { stdio: ["ignore", "ignore", "pipe"], detached: false }
    );
    xvfb.on("error", (e) => { log(`[Xvfb] ERROR: ${e.message}`); reject(e); });
    setTimeout(() => {
      if (!isDisplayAlive(DISPLAY_NUM)) {
        log(`[Xvfb] Warning: display ${DISPLAY_NUM} not responding after start`);
      }
      resolve(xvfb);
    }, 2000);
  });
}

// ── waitForCF — handles Cloudflare + SECUREGATEWAY ───────────────────────────
async function waitForCF(page, ms = 90000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const title = await page.title().catch(() => "");
    const url   = page.url();

    if (title.toLowerCase().includes("just a moment") || url.includes("cdn-cgi/challenge")) {
      log("  [CF] Cloudflare challenge active — waiting...");
      await sleep(2000);
      continue;
    }

    const sgState = await page.evaluate(() => {
      const body = (document.body && document.body.innerText) || "";
      const hasGateway = document.querySelector(".securegateway, [class*='securegateway']") ||
        body.includes("SECUREGATEWAY") || body.includes("Checking Browser") || body.includes("Analyzing Network");
      if (!hasGateway) return null;
      const verified = body.includes("Verification Complete") || body.includes("VERIFIED");
      const btn = Array.from(document.querySelectorAll("button, a")).find(el =>
        (el.innerText || "").toLowerCase().includes("continue")
      );
      return { verified, hasBtn: !!btn };
    }).catch(() => null);

    if (sgState) {
      if (sgState.verified && sgState.hasBtn) {
        log("  [SG] SECUREGATEWAY verified — clicking Continue to Next...");
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button, a")).find(el =>
            (el.innerText || "").toLowerCase().includes("continue")
          );
          if (btn) btn.click();
        }).catch(() => {});
        await sleep(3000);
        continue;
      }
      log("  [SG] SECUREGATEWAY analyzing — waiting...");
      await sleep(2000);
      continue;
    }

    return;
  }
  log("  [CF/SG] Warning: challenge may not have cleared.");
}

// ── waitForUrl ────────────────────────────────────────────────────────────────
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

// ── readCountdown ─────────────────────────────────────────────────────────────
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

// ── waitForCountdown ──────────────────────────────────────────────────────────
async function waitForCountdown(page, maxMs = 45000, label = "", minMs = 15000) {
  const prefix = label ? `[${label}] ` : "";
  await sleep(1500);
  const dl    = Date.now() + maxMs;
  const minDl = Date.now() + minMs;
  let last = -1, seen = false;
  while (Date.now() < dl) {
    const secs = await readCountdown(page);
    if (secs !== last) { log(`  ${prefix}Countdown: ${secs}s`); last = secs; }
    if (secs > 0) seen = true;
    if (secs <= 0 && Date.now() >= minDl) return;
    await sleep(1000);
  }
  if (!seen) log(`  ${prefix}No countdown found — used ${minMs / 1000}s floor.`);
}

// ── clickButton ───────────────────────────────────────────────────────────────
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
          if (!el.disabled) { el.click(); return "text:" + (el.innerText || "").trim().slice(0, 40); }
        }
      }
      return null;
    },
    selectors, textMatches,
  ).catch(() => null);
  if (result) log(`  ✓ Clicked ${label} (${result})`);
  else        log(`  ✗ ${label} not found`);
  return !!result;
}

// ── handleAdPage — one evspec/rank1st ad page ─────────────────────────────────
async function handleAdPage(page, label) {
  log(`\n── Ad page [${label}] — ${page.url()} ──`);
  await shot(page, `ad-${label}-start`);

  await waitForCountdown(page, 35000, label, 15000);
  await shot(page, `ad-${label}-after-countdown`);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(800);

  const notRobot = await clickButton(page, ["button.tp-unlock-btn", ".tp-unlock-btn"], ["not robot", "i'm not", "human"], "I'm Not Robot");
  if (notRobot) await sleep(2000);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(600);
  await shot(page, `ad-${label}-pre-verify`);

  const verified = await clickButton(page, ["button.tp-btn.tp-blue", "button.tp-btn"], ["verify", "verifiy"], "Verify");
  if (verified) await sleep(1500);

  await clickButton(page, ["button.tp-btn.tp-blue", "button.tp-btn", ".tp-btn"], ["continue", "next", "proceed"], "Continue");
  await sleep(3000);

  log(`  → After ad page: ${page.url()}`);
  await shot(page, `ad-${label}-done`);
}

// ── getCoins ──────────────────────────────────────────────────────────────────
async function getCoins(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".topbar-pill strong");
    return el ? parseInt(el.innerText.trim(), 10) || 0 : 0;
  }).catch(() => 0);
}

// ── getLinkPaysStatus ─────────────────────────────────────────────────────────
async function getLinkPaysStatus(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("article.offer-card"));
    let lpCard = null;
    for (const c of cards) {
      if ((c.textContent || "").toLowerCase().includes("linkpays")) { lpCard = c; break; }
    }
    if (!lpCard) return { available: false, cooldownSec: 0, usageToday: 0, maxUsage: 10, flash: "" };

    const btn = lpCard.querySelector('button.button-primary[type="submit"]');
    const available = !!btn && !btn.disabled;

    const pills = Array.from(lpCard.querySelectorAll(".status-pill"));
    let usageToday = 0, maxUsage = 10, cooldownSec = 0;

    for (const pill of pills) {
      const text = (pill.innerText || "").trim();
      if (/usage/i.test(text)) {
        const m = text.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) { usageToday = parseInt(m[1], 10); maxUsage = parseInt(m[2], 10); }
      }
      const slotMatch = text.match(/next slot opens in\s*(?:(\d+)h)?\s*(?:(\d+)m)?/i);
      if (slotMatch) {
        const h  = parseInt(slotMatch[1] || "0", 10);
        const m2 = parseInt(slotMatch[2] || "0", 10);
        cooldownSec = h * 3600 + m2 * 60;
      }
    }

    if (cooldownSec === 0) {
      const expEl = lpCard.querySelector("[data-expire-seconds]");
      if (expEl) cooldownSec = parseInt(expEl.getAttribute("data-expire-seconds") || "0", 10);
    }

    const flashEl = document.querySelector(".alert, .flash, [role='alert'], .notice");
    const flash   = flashEl ? (flashEl.textContent || "").trim() : "";

    return { available, cooldownSec, usageToday, maxUsage, flash };
  }).catch(() => ({ available: false, cooldownSec: 0, usageToday: 0, maxUsage: 10, flash: "" }));
}

// ── keepAliveOnce — scroll /earn to maintain session ─────────────────────────
async function keepAliveOnce(page) {
  await page.evaluate(() => window.scrollTo(0, 300)).catch(() => {});
  await sleep(400);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

// ── doLogin — reusable login flow (called on startup and on session expiry) ───
async function doLogin(page) {
  log("[Login] Navigating to login page...");
  await safeGoto(page, `${SITE}/login`, 60000);
  await waitForCF(page);
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 }).catch(() => {});
  await sleep(600);

  let emailEl = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl) {
    log("[Login] Email input not found — reloading...");
    await safeGoto(page, `${SITE}/login`, 60000);
    await waitForCF(page); await sleep(800);
    emailEl = await page.$('input[type="email"], input[name="email"]');
  }
  if (!emailEl) throw new Error("No email input on login page");

  await emailEl.click({ clickCount: 3 });
  await emailEl.type(EMAIL, { delay: 55 });
  const passEl = await page.$('input[type="password"]');
  if (!passEl) throw new Error("No password input on login page");
  await passEl.click({ clickCount: 3 });
  await passEl.type(PASSWORD, { delay: 55 });

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
    page.keyboard.press("Enter"),
  ]);
  await waitForCF(page);

  if (page.url().includes("/login")) {
    await safeGoto(page, `${SITE}/earn`, 30000);
    await waitForCF(page);
    if (page.url().includes("/login")) throw new Error("Login failed — still on /login");
  }

  if (!page.url().includes("/earn")) {
    await safeGoto(page, `${SITE}/earn`, 30000);
    await waitForCF(page);
  }
  log(`[Login] ✓ Logged in: ${page.url()}`);
}

// ── ensureLoggedIn — detect session expiry and re-login if needed ─────────────
async function ensureLoggedIn(page) {
  const url = page.url();
  if (url.includes("/login") || url.includes("/logout") || (!url.includes(SITE) && url !== "about:blank")) {
    log(`⚠️  Session expired (landed on ${url}) — re-logging in...`);
    await doLogin(page);
    return true;
  }
  return false;
}

// ── runLinkPaysCycle — exact flow from test-linkpays.js ──────────────────────
async function runLinkPaysCycle(page, cycleNum) {
  resetStepNum();
  log(`\n${"═".repeat(55)}`);
  log(`LINKPAYS CYCLE ${cycleNum} START`);

  // ── STEP 1: Navigate to /earn + status check ─────────────────────────
  log("\n── STEP 1: Navigate to /earn ──");
  await safeGoto(page, `${SITE}/earn`, 60000);
  log("  [step1] page landed — waiting for CF...");
  await waitForCF(page);
  await ensurePageAlive(page, `${SITE}/earn`);
  await ensureLoggedIn(page);
  await sleep(1000);
  log("  [step1] taking screenshot...");
  await shot(page, "earn-page");

  const coinsBefore = await getCoins(page);
  const status = await getLinkPaysStatus(page);
  log(`Coins before: ${coinsBefore} | LP: available=${status.available} usage=${status.usageToday}/${status.maxUsage} cooldown=${status.cooldownSec}s`);

  // Daily limit 10/10 — sleep until rolling window re-opens
  if (status.usageToday >= status.maxUsage) {
    if (status.cooldownSec > 0) {
      const h = Math.floor(status.cooldownSec / 3600);
      const m = Math.floor((status.cooldownSec % 3600) / 60);
      log(`💤 Daily limit (${status.usageToday}/${status.maxUsage}). Next slot in ${h}h ${m}m — sleeping.`);
      return { success: false, waitMs: (status.cooldownSec + 60) * 1000, dailyLimitHit: true };
    }
    log(`💤 Daily limit (${status.usageToday}/${status.maxUsage}). No slot timer — sleeping 1h.`);
    return { success: false, waitMs: 3_600_000, dailyLimitHit: true };
  }

  // Slot not yet open
  if (status.cooldownSec > 0) {
    const h = Math.floor(status.cooldownSec / 3600);
    const m = Math.floor((status.cooldownSec % 3600) / 60);
    log(`⏳ Next slot opens in ${h}h ${m}m — sleeping until ${new Date(Date.now() + status.cooldownSec * 1000).toLocaleTimeString()}`);
    return { success: false, waitMs: (status.cooldownSec + 30) * 1000 };
  }

  if (!status.available) {
    log("LinkPays button not available — retrying in 5 minutes.");
    return { success: false, waitMs: 300_000 };
  }

  const cycleStart = Date.now();

  // ── STEP 2: Click "Open LinkPays" ───────────────────────────────────
  log("\n── STEP 2: Click Open LinkPays ──");
  const lpBtn = await page.$('button.button-primary[type="submit"], button.button.button-primary');
  if (!lpBtn) {
    log("ERROR: LinkPays button not found on /earn page");
    return { success: false, waitMs: 30_000 };
  }

  log("  Clicking button — POST /earn/linkpays/start will fire + redirect to linkpays.in...");
  await lpBtn.click();

  log("  Waiting for MAIN TAB to navigate to linkpays.in...");
  let linkpaysUrl;
  try {
    linkpaysUrl = await waitForUrl(page, ["linkpays.in"], 20000, "main-tab");
  } catch {
    log(`  Current URL: ${page.url()} — did not reach linkpays.in in 20s`);
    return { success: false, waitMs: 30_000 };
  }
  log(`  ✓ On linkpays.in: ${linkpaysUrl}`);
  await waitForCF(page, 30000);
  await sleep(1000);
  await shot(page, "linkpays-page");

  // ── STEP 3: proceed() on linkpays.in ────────────────────────────────
  log("\n── STEP 3: proceed() on linkpays.in ──");
  const proceedTarget = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const m = (s.textContent || "").match(/atob\("([A-Za-z0-9+/=]+)"\)/);
      if (m) { try { return atob(m[1]); } catch { return ""; } }
    }
    return "";
  }).catch(() => "");
  log(`  proceed() target: ${proceedTarget || "(not found yet)"}`);

  await sleep(4000, "auto-proceed timer");
  const proceedCalled = await page.evaluate(() => {
    if (typeof proceed === "function") { proceed(); return true; }
    return false;
  }).catch(() => false);
  log(`  proceed() manually called: ${proceedCalled}`);

  // ── STEP 4: Navigate to ad site ─────────────────────────────────────
  log("\n── STEP 4: Navigate to ad site ──");
  let adSiteUrl;
  try {
    adSiteUrl = await waitForUrl(page, ["evspec.in", "rank1st.in", "savepe.in", "bookyourhotel.in", "earn/linkpays/complete"], 30000, "ad-site");
  } catch {
    const u = page.url();
    log(`  WARNING: Still on ${u} — checking if still linkpays.in...`);
    if (u.includes("linkpays.in")) {
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

  // ── STEP 5: Ad page loop (max 4 pages) ──────────────────────────────
  log("\n── STEP 5: Ad page loop ──");
  const MAX_AD_PAGES = 4;
  let adPagesDone = 0, prevLoopUrl = "", sameStreak = 0;
  for (let i = 1; i <= 30; i++) {
    const u = page.url();
    log(`\n  [loop ${i}] URL: ${u}`);

    if (u.includes("vektalnodes.in"))   { log("  ✓ Back on vektalnodes.in!"); break; }
    if (u.includes("bookyourhotel.in")) { log("  → bookyourhotel.in reached"); break; }

    if (u.includes("google_vignette")) {
      log("  Google vignette — waiting up to 10s for auto-redirect...");
      for (let j = 0; j < 10; j++) {
        await sleep(1000);
        const nu = page.url();
        if (!nu.includes("google_vignette")) { log(`  → Redirected to: ${nu}`); break; }
      }
      continue;
    }

    // Once 4 ad pages are done, just wait for bookyourhotel.in redirect
    if (adPagesDone >= MAX_AD_PAGES) {
      log(`  ✅ ${MAX_AD_PAGES} ad pages complete — waiting for bookyourhotel.in redirect...`);
      await sleep(3000);
      continue;
    }

    const isAd = await page.evaluate(() => !!(
      document.querySelector("button.tp-unlock-btn") ||
      document.querySelector("button.tp-btn") ||
      document.querySelector(".tp-unlock-btn") ||
      document.querySelector("[class*='tp-']")
    )).catch(() => false);

    if (isAd) {
      sameStreak = 0;
      adPagesDone++;
      log(`  → Ad page ${adPagesDone}/${MAX_AD_PAGES}`);
      await handleAdPage(page, `p${adPagesDone}`);
    } else {
      if (u === prevLoopUrl) {
        sameStreak++;
        if (sameStreak >= 5) {
          log(`  ⚠️  Stuck on same URL (${sameStreak}×) — reloading...`);
          await Promise.race([
            page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
            new Promise((r) => setTimeout(r, 18000)),
          ]);
          sameStreak = 0;
          await sleep(3000);
          continue;
        }
      } else {
        sameStreak = 0;
      }
      const waitMs = sameStreak > 0 ? 8000 : 5000;
      log(`  Not an ad page (streak: ${sameStreak}) — waiting ${waitMs / 1000}s for auto-redirect...`);
      await sleep(waitMs);
    }
    prevLoopUrl = u;
  }

  // ── STEP 6: bookyourhotel.in — Get Link ─────────────────────────────
  log("\n── STEP 6: bookyourhotel.in (final gateway) ──");
  let onHotel = false;
  for (let i = 0; i < 20; i++) {
    const u = page.url();
    if (u.includes("bookyourhotel.in")) { onHotel = true; break; }
    if (u.includes("vektalnodes.in"))   { log(`  Already back on vektalnodes: ${u}`); break; }
    await sleep(1000);
  }

  if (onHotel) {
    log(`  On bookyourhotel.in: ${page.url()}`);
    await shot(page, "hotel-start");

    await waitForCountdown(page, 50000, "hotel", 30000);

    const elapsed = Math.floor((Date.now() - cycleStart) / 1000);
    if (elapsed < MIN_FLOW_S) {
      const stillNeeded = (MIN_FLOW_S - elapsed) * 1000;
      log(`  Total elapsed: ${elapsed}s — waiting ${MIN_FLOW_S - elapsed}s more for 240s server minimum...`);
      await sleep(stillNeeded, "server 240s minimum");
    } else {
      log(`  Total elapsed: ${elapsed}s — past 240s minimum ✓`);
    }

    await shot(page, "hotel-after-wait");

    const gotLink = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit]"));
      for (const el of all) {
        const txt = ((el.innerText || el.value || el.textContent) || "").trim().toLowerCase();
        if (txt === "get link" || txt === "get links" || txt === "getlink") {
          el.click(); return el.innerText || el.value || txt;
        }
      }
      for (const el of all) {
        const txt = ((el.innerText || el.value || el.textContent) || "").trim().toLowerCase();
        if (txt.startsWith("get link")) { el.click(); return el.innerText || el.value || txt; }
      }
      return null;
    }).catch(() => null);

    if (gotLink) log(`  ✓ Clicked Get Link: "${gotLink}"`);
    else {
      log("  ✗ Get Link not found by text — trying CSS fallback...");
      await clickButton(page, ["#get-link", ".get-link-btn", "[id*='get']", "[class*='get-link']"], [], "Get Link CSS");
    }

    log("  Waiting for redirect after Get Link...");
    await sleep(8000);
    log(`  After Get Link: ${page.url()}`);
    await shot(page, "hotel-after-get-link");
  }

  // ── STEP 7: Final — verify coins ────────────────────────────────────
  log("\n── STEP 7: Final check ──");
  const finalUrl = page.url();
  log(`  Final URL: ${finalUrl}`);
  await shot(page, "final-url");

  await sleep(5000);
  log(`  URL after wait: ${page.url()}`);

  if (!page.url().includes(`${SITE}/earn`)) {
    try {
      await safeGoto(page, `${SITE}/earn`, 30000);
      await waitForCF(page, 15000);
      await sleep(1500);
    } catch {}
  }
  await shot(page, "earn-final");

  const coinsAfter = await getCoins(page);
  const diff       = coinsAfter - coinsBefore;
  const flashEl    = await page.evaluate(() => {
    const el = document.querySelector(".alert, .flash, [role='alert'], .notice");
    return el ? (el.textContent || "").trim() : "";
  }).catch(() => "");

  log("");
  log("═".repeat(55));
  log(`Coins BEFORE : ${coinsBefore}`);
  log(`Coins AFTER  : ${coinsAfter}`);
  log(`Diff         : ${diff >= 0 ? "+" : ""}${diff}`);
  if (flashEl) log(`Flash msg    : ${flashEl}`);
  const totalTime = Math.round((Date.now() - cycleStart) / 1000);
  log(`Total time   : ${totalTime}s`);

  if (diff >= 12) {
    log("✅ SUCCESS — earned 12 coins!");
    log("═".repeat(55));
    return { success: true, waitMs: 0 };
  } else {
    log(`⚠️  Coin diff ${diff} — cycle may not have been credited.`);
    log("═".repeat(55));
    return { success: false, waitMs: 60_000 };
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  log("=== Vektal AFK Bot (bot.js) ===");

  const chrome = findChrome();
  if (!chrome) { log("ERROR: Chrome/Chromium not found."); process.exit(1); }
  const snap = isSnap(chrome);
  log(`Chrome: ${chrome} (snap: ${snap})`);

  const xvfb = await startXvfb().catch((e) => { log(`Xvfb failed: ${e.message}`); return null; });
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

  let browser, page;
  const cleanup = () => {
    log("Shutting down...");
    try { browser?.close(); } catch {}
    if (xvfb) { try { xvfb.kill("SIGTERM"); } catch {} }
  };
  process.on("SIGINT",  () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  try {
    log("Launching browser (puppeteer-real-browser)...");
    let result;
    const BROWSER_RETRIES = 3;
    for (let attempt = 1; attempt <= BROWSER_RETRIES; attempt++) {
      try {
        result = await connect({
          headless: false,
          args: snap ? [...launcherDefaults, ...commonArgs] : [...commonArgs],
          customConfig: { chromePath: chrome },
          turnstile: true,
          connectOption: { defaultViewport: { width: 1280, height: 900 } },
          disableXvfb: true,
          ignoreAllFlags: snap,
        });
        break;
      } catch (e) {
        log(`[Browser] Launch attempt ${attempt}/${BROWSER_RETRIES} failed: ${e.message}`);
        if (attempt < BROWSER_RETRIES) {
          log(`[Browser] Retrying in 5s...`);
          await sleep(5000);
        } else {
          throw e;
        }
      }
    }
    browser = result.browser;
    page    = result.page;
    page.setDefaultNavigationTimeout(90000);
    page.on("dialog", async (d) => { log(`Dialog: ${d.message()}`); await d.dismiss(); });
    log("Browser launched ✓");

    // ── Login ─────────────────────────────────────────────────────────
    log("\n── Login ──");
    await safeGoto(page, SITE, 60000);
    await waitForCF(page, 60000);
    await sleep(1000);
    await doLogin(page);

    // ── Main loop ─────────────────────────────────────────────────────
    let cycleNum = 0;
    let afkTick  = 0;

    // Load persisted slot timestamps — each entry = when that slot was last used
    let slotLog = loadSlotLog();
    log(`\n[Slots] Loaded ${slotLog.length} slot(s) from log. Active in last 24h: ${activeSlots(slotLog).length}`);
    logSlotStatus(slotLog);

    // Determine first wake time from local slot log
    let nextCycleAt = Date.now() + msUntilNextSlot(slotLog);
    if (nextCycleAt > Date.now()) {
      const wakeAt = new Date(nextCycleAt).toLocaleTimeString();
      log(`[Slots] Next free slot opens at ${wakeAt} — sleeping until then.`);
    } else {
      log("[Slots] A slot is free now — starting cycle immediately.");
    }

    log(`\nBot running. Will earn up to ${MAX_DAILY} × 12 = ${MAX_DAILY * 12} coins/day.`);
    log("Press Ctrl+C to stop.\n");

    while (true) {
      const now = Date.now();

      // ── LinkPays cycle ───────────────────────────────────────────
      if (now >= nextCycleAt) {
        // Double-check local slot log — confirm a slot is actually free
        const waitMs = msUntilNextSlot(slotLog);
        if (waitMs > 0) {
          const wakeAt = new Date(Date.now() + waitMs).toLocaleTimeString();
          log(`[Slots] All ${MAX_DAILY} slots still active — next opens at ${wakeAt}`);
          nextCycleAt = Date.now() + waitMs;
        } else {
          cycleNum++;
          try {
            const res = await runLinkPaysCycle(page, cycleNum);
            if (res.success) {
              // Record the slot use — this slot reopens exactly 24h from now
              slotLog = recordSlotUse(slotLog);
              const active = activeSlots(slotLog);
              log(`[Slots] Slot recorded. ${active.length}/${MAX_DAILY} used in last 24h.`);
              logSlotStatus(slotLog);

              // Schedule next cycle: either immediately (slot free) or when oldest slot expires
              const nextWait = msUntilNextSlot(slotLog);
              if (nextWait === 0) {
                nextCycleAt = Date.now() + 30_000;  // small buffer then run again
                log(`[Slots] Another slot is free — next cycle in 30s.`);
              } else {
                nextCycleAt = Date.now() + nextWait;
                const wakeAt = new Date(nextCycleAt).toLocaleTimeString();
                log(`⏳ Next slot opens at ${wakeAt} — sleeping until then.`);
              }
            } else if (res.waitMs > 0) {
              // Page says wait — but also check our local slot log
              const localWait = msUntilNextSlot(slotLog);
              const effectiveWait = localWait > 0 ? Math.max(res.waitMs, localWait) : res.waitMs;
              nextCycleAt = Date.now() + effectiveWait;
              log(`Waiting ${Math.round(effectiveWait / 1000)}s before next attempt (page: ${Math.round(res.waitMs/1000)}s, local slot: ${Math.round(localWait/1000)}s)...`);
            } else {
              nextCycleAt = Date.now() + 60_000;
            }
          } catch (err) {
            log(`Cycle ${cycleNum} ERROR: ${err.message}`);
            nextCycleAt = Date.now() + 60_000;
          }

          // Return to /earn after cycle
          try {
            if (!page.url().includes("vektalnodes.in/earn")) {
              await safeGoto(page, `${SITE}/earn`, 30000);
              await waitForCF(page, 15000);
            }
          } catch {}
        }
      }

      // ── AFK keep-alive tick ──────────────────────────────────────
      afkTick++;
      await keepAliveOnce(page).catch(() => {});

      // Reload /earn for fresh status
      try {
        if (!page.url().includes(`${SITE}/earn`)) {
          await safeGoto(page, `${SITE}/earn`, 30000);
        } else {
          await Promise.race([
            page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
            new Promise((r) => setTimeout(r, 33000)),
          ]);
        }
        await waitForCF(page, 10000);
        // Auto-recover if session expired during cooldown wait
        await ensureLoggedIn(page).catch((e) => log(`[AutoLogin] Re-login failed: ${e.message}`));
      } catch {}

      const liveStatus = await getLinkPaysStatus(page).catch(() => null);
      const coins      = await getCoins(page).catch(() => "?");
      const secToNext  = Math.max(0, Math.round((nextCycleAt - Date.now()) / 1000));
      const activeNow  = activeSlots(slotLog).length;
      const usageStr   = liveStatus
        ? `${liveStatus.usageToday}/${liveStatus.maxUsage}`
        : `${activeNow}/${MAX_DAILY}`;
      log(`[AFK tick ${afkTick}] Coins: ${coins} | Usage: ${usageStr} | Next LP cycle: ${secToNext > 0 ? secToNext + "s" : "NOW"}`);

      // If page shows a slot-open time, cross-check with our local tracker
      // and use whichever is later (safer — avoids wasting a cycle that will be rejected)
      if (liveStatus && liveStatus.cooldownSec > 0) {
        const pageWaitMs  = liveStatus.cooldownSec * 1000;
        const localWaitMs = msUntilNextSlot(slotLog);
        const bestWaitMs  = Math.max(pageWaitMs, localWaitMs);
        const wakeAt      = new Date(Date.now() + bestWaitMs).toLocaleTimeString();
        const isFull      = liveStatus.usageToday >= liveStatus.maxUsage;
        const label       = isFull
          ? `💤 Daily limit (${liveStatus.usageToday}/${liveStatus.maxUsage}) — next slot at ${wakeAt}`
          : `⏳ Next slot in ${Math.floor(bestWaitMs / 60000)}m — sleeping until ${wakeAt}`;
        log(label);
        nextCycleAt = Date.now() + bestWaitMs;
        await sleep(60_000);
      } else if (liveStatus && liveStatus.usageToday >= liveStatus.maxUsage) {
        // Page says full but no timer — trust local slot log
        const localWaitMs = msUntilNextSlot(slotLog);
        if (localWaitMs > 0) {
          const wakeAt = new Date(Date.now() + localWaitMs).toLocaleTimeString();
          log(`💤 Daily limit — local slot opens at ${wakeAt}`);
          nextCycleAt = Date.now() + localWaitMs;
        } else {
          log(`💤 Daily limit — no timer visible, re-checking in 1h`);
          nextCycleAt = Date.now() + 3_600_000;
        }
        await sleep(60_000);
      } else {
        await sleep(60_000);
      }
    }

  } catch (err) {
    log(`FATAL: ${err.message}`);
    console.error(err.stack);
    cleanup();
    process.exit(1);
  }
})();
