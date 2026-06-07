/**
 * bot.js — AFK Bot for vektalnodes.in/earn
 *
 * - Stays logged in, keeps session alive (AFK mode)
 * - Runs LinkPays earn cycle every 310s, up to 10x per day → 120 coins/day
 *
 * Flow (proven working):
 *   /earn → click "Open LinkPays"
 *   → POST /earn/linkpays/start → 302 → linkpays.in (MAIN TAB)
 *   → proceed() after 4s → evspec.in / rank1st.in ad site
 *   → 4 ad pages (15s wait + Verify + Continue each)
 *   → bookyourhotel.in → wait for countdown + 240s minimum → GET LINK
 *   → linkpays.in → vektalnodes.in/earn/linkpays/complete?token=...
 *   → ✅ 12 coins credited
 */

require("dotenv").config();
const { connect } = require("puppeteer-real-browser");
const { spawn, execSync } = require("child_process");
const { appendFileSync, existsSync } = require("fs");

const SITE         = "https://vektalnodes.in";
const EMAIL        = process.env.EMAIL    || process.env.VEKTAL_EMAIL    || "";
const PASSWORD     = process.env.PASSWORD || process.env.VEKTAL_PASSWORD || "";
const DISPLAY_NUM  = ":94";
const XVFB_PATH    = "/usr/bin/Xvfb";
const COOLDOWN_MS  = 250_000;   // 250s default cooldown
const MAX_DAILY    = 10;
const MIN_FLOW_S   = 245;        // server requires 240s minimum

if (!EMAIL || !PASSWORD) {
  console.error("[ERROR] EMAIL and PASSWORD must be set in .env");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toLocaleTimeString(); }
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { appendFileSync("/tmp/vektal-bot.log", line + "\n"); } catch {}
}
async function sleep(ms, label) {
  if (label) log(`  ⏳ ${label} — waiting ${Math.round(ms / 1000)}s...`);
  return new Promise((r) => setTimeout(r, ms));
}

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

function startXvfb() {
  if (process.env.DISPLAY) {
    log(`[Xvfb] DISPLAY=${process.env.DISPLAY} already set — skipping.`);
    return Promise.resolve(null);
  }
  if (!existsSync(XVFB_PATH)) {
    log("[Xvfb] Not installed. Run: sudo apt-get install -y xvfb");
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    log(`[Xvfb] Starting on display ${DISPLAY_NUM}...`);
    const xvfb = spawn(XVFB_PATH,
      [DISPLAY_NUM, "-screen", "0", "1280x900x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
      { stdio: ["ignore", "ignore", "pipe"], detached: false }
    );
    xvfb.on("error", (e) => { log(`[Xvfb] ERROR: ${e.message}`); reject(e); });
    setTimeout(() => resolve(xvfb), 2000);
  });
}

async function waitForCF(page, ms = 90000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const title = await page.title().catch(() => "");
    const url   = page.url();
    if (!title.toLowerCase().includes("just a moment") && !url.includes("cdn-cgi/challenge")) return;
    log("  [CF] Cloudflare challenge active — waiting...");
    await sleep(2000);
  }
}

async function waitForUrl(page, matches, timeoutMs = 60000, label = "") {
  const dl = Date.now() + timeoutMs;
  let prev = "";
  while (Date.now() < dl) {
    const u = page.url();
    if (u !== prev) { log(`  ${label ? "[" + label + "] " : ""}→ ${u}`); prev = u; }
    if (matches.some((m) => u.includes(m))) return u;
    await sleep(800);
  }
  return null; // non-throwing — callers check null
}

async function readCountdown(page) {
  return page.evaluate(() => {
    const sels = ["#timer","#countdown",".timer",".countdown","[id*='timer']","[id*='count']","[class*='timer']","[class*='count']"];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      const n = parseInt((el.innerText || el.textContent || "").trim(), 10);
      if (!isNaN(n) && n >= 0) return n;
    }
    return 0;
  }).catch(() => 0);
}

async function waitForCountdown(page, maxMs = 50000, label = "", minMs = 15000) {
  await sleep(1500);
  const dl    = Date.now() + maxMs;
  const minDl = Date.now() + minMs;
  let last = -1, seen = false;
  while (Date.now() < dl) {
    const s = await readCountdown(page);
    if (s !== last) { log(`  [${label}] Countdown: ${s}s`); last = s; }
    if (s > 0) seen = true;
    if (s <= 0 && Date.now() >= minDl) return;
    await sleep(1000);
  }
  if (!seen) log(`  [${label}] No countdown found — used ${minMs / 1000}s floor.`);
}

async function clickButton(page, selectors, texts) {
  return page.evaluate((sels, txts) => {
    for (const s of sels) {
      try { const el = document.querySelector(s); if (el && !el.disabled) { el.click(); return s; } } catch {}
    }
    for (const el of Array.from(document.querySelectorAll("button,a,input[type=submit],[role=button]"))) {
      const t = (el.innerText || el.value || "").toLowerCase();
      if (txts.some((x) => t.includes(x.toLowerCase()))) { if (!el.disabled) { el.click(); return "text:" + t.slice(0,30); } }
    }
    return null;
  }, selectors, texts).catch(() => null);
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(page) {
  log("Navigating to homepage (warm up CF trust)...");
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await waitForCF(page, 60000);
  await sleep(1500);

  log("Navigating to /login...");
  await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForCF(page);
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 }).catch(() => {});
  await sleep(600);

  let emailEl = await page.$('input[type="email"], input[name="email"]');
  if (!emailEl) {
    log("Email input not found — reloading...");
    await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
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
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForCF(page);
    if (page.url().includes("/login")) throw new Error("Login failed — still on /login");
  }
  log(`✓ Logged in: ${page.url()}`);
}

// ── Get current coin balance ──────────────────────────────────────────────────
async function getCoins(page) {
  const t = await page.evaluate(() => {
    const el = document.querySelector(".topbar-pill strong");
    return el ? el.innerText.trim() : "0";
  }).catch(() => "0");
  return parseInt(t, 10) || 0;
}

// ── Get LinkPays button status from /earn ─────────────────────────────────────
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

    // Read all .status-pill spans inside the card
    const pills = Array.from(lpCard.querySelectorAll(".status-pill"));
    let usageToday = 0, maxUsage = 10, cooldownSec = 0;

    for (const pill of pills) {
      const text = (pill.innerText || "").trim();

      // "24h usage: 9 / 10"
      if (/usage/i.test(text)) {
        const m = text.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) { usageToday = parseInt(m[1], 10); maxUsage = parseInt(m[2], 10); }
      }

      // "Next slot opens in 4h 42m" / "Next slot opens in 30m" / "Next slot opens in 2h"
      const slotMatch = text.match(/next slot opens in\s*(?:(\d+)h)?\s*(?:(\d+)m)?/i);
      if (slotMatch) {
        const h = parseInt(slotMatch[1] || "0", 10);
        const m2 = parseInt(slotMatch[2] || "0", 10);
        cooldownSec = h * 3600 + m2 * 60;
      }
    }

    // Fallback: data-expire-seconds attribute
    if (cooldownSec === 0) {
      const expEl = lpCard.querySelector("[data-expire-seconds]");
      if (expEl) cooldownSec = parseInt(expEl.getAttribute("data-expire-seconds") || "0", 10);
    }

    const flashEl = document.querySelector(".alert, .flash, [role='alert'], .notice");
    const flash = flashEl ? (flashEl.textContent || "").trim() : "";

    return { available, cooldownSec, usageToday, maxUsage, flash };
  }).catch(() => ({ available: false, cooldownSec: 0, usageToday: 0, maxUsage: 10, flash: "" }));
}

// ── Handle one evspec/rank1st ad page ─────────────────────────────────────────
async function handleAdPage(page, num) {
  log(`\n── Ad page ${num} — ${page.url()} ──`);

  // Wait for the countdown (15s floor)
  await waitForCountdown(page, 35000, `ad${num}`, 15000);

  // Scroll to reveal buttons
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(800);

  // I'm Not Robot (optional)
  const notRobot = await clickButton(page, ["button.tp-unlock-btn", ".tp-unlock-btn"], ["not robot", "i'm not", "human"]);
  if (notRobot) { log(`  ✓ I'm Not Robot (${notRobot})`); await sleep(2000); }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(600);

  // Verify
  const verify = await clickButton(page, ["button.tp-btn.tp-blue", "button.tp-btn"], ["verify", "verifiy"]);
  if (verify) { log(`  ✓ Verify (${verify})`); await sleep(1500); }

  // Continue
  const cont = await clickButton(page, ["button.tp-btn.tp-blue", "button.tp-btn", ".tp-btn"], ["continue", "next", "proceed"]);
  if (cont) { log(`  ✓ Continue (${cont})`); }

  await sleep(3000);
  log(`  → ${page.url()}`);
}

// ── One full LinkPays earn cycle ──────────────────────────────────────────────
async function runLinkPaysCycle(page, cycleNum) {
  log(`\n${"═".repeat(55)}`);
  log(`LINKPAYS CYCLE ${cycleNum} START`);

  // Go to /earn
  await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForCF(page);
  await sleep(1000);

  const coinsBefore = await getCoins(page);
  const status = await getLinkPaysStatus(page);
  log(`Coins: ${coinsBefore} | LP: available=${status.available} usage=${status.usageToday}/${status.maxUsage} cooldown=${status.cooldownSec}s`);

  if (!status.available) {
    if (status.cooldownSec > 0) {
      log(`Cooldown active — ${status.cooldownSec}s remaining. Skipping cycle.`);
      return { success: false, waitMs: (status.cooldownSec + 10) * 1000 };
    }
    log("LinkPays not available (daily limit or disabled).");
    return { success: false, waitMs: 0 };
  }

  const cycleStart = Date.now();

  // Click "Open LinkPays" — fires POST /earn/linkpays/start → 302 → linkpays.in
  log("Clicking Open LinkPays...");
  const lpBtn = await page.$('button.button-primary[type="submit"], button.button.button-primary');
  if (!lpBtn) { log("ERROR: LinkPays button not found"); return { success: false, waitMs: 30000 }; }
  await lpBtn.click();

  // Wait for MAIN TAB to navigate to linkpays.in
  const linkpaysUrl = await waitForUrl(page, ["linkpays.in"], 20000, "linkpays");
  if (!linkpaysUrl) {
    log(`WARNING: Main tab did not reach linkpays.in (current: ${page.url()})`);
    return { success: false, waitMs: 30000 };
  }
  log(`✓ On linkpays.in`);
  await waitForCF(page, 30000);
  await sleep(1000);

  // Decode proceed() target and call it after 4s
  const proceedTarget = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const m = (s.textContent || "").match(/atob\("([A-Za-z0-9+/=]+)"\)/);
      if (m) { try { return atob(m[1]); } catch { return ""; } }
    }
    return "";
  }).catch(() => "");
  log(`proceed() target: ${proceedTarget || "(not found)"}`);

  await sleep(4000);
  const called = await page.evaluate(() => {
    if (typeof proceed === "function") { proceed(); return true; }
    return false;
  }).catch(() => false);
  log(`proceed() called: ${called}`);

  // Wait for ad site
  const adUrl = await waitForUrl(page, ["evspec.in","rank1st.in","savepe.in","bookyourhotel.in","earn/linkpays/complete"], 30000, "ad-site");
  if (!adUrl) { log(`WARNING: Did not reach ad site (current: ${page.url()})`); return { success: false, waitMs: 30000 }; }
  log(`✓ Ad site: ${adUrl}`);

  // Loop through ad pages
  let adsDone = 0, prevUrl = "";
  for (let i = 1; i <= 20; i++) {
    const u = page.url();
    if (u.includes("vektalnodes.in")) { log("✓ Back on vektalnodes.in"); break; }
    if (u.includes("bookyourhotel.in")) { log("→ bookyourhotel.in reached"); break; }
    if (u.includes("#google_vignette") || u.includes("google_vignette")) {
      for (let j = 0; j < 10; j++) { await sleep(1000); if (!page.url().includes("google_vignette")) break; }
      continue;
    }

    const isAd = await page.evaluate(() => !!(
      document.querySelector("button.tp-unlock-btn") ||
      document.querySelector("button.tp-btn") ||
      document.querySelector("[class*='tp-']")
    )).catch(() => false);

    if (isAd) {
      adsDone++;
      await handleAdPage(page, adsDone);
    } else {
      const waitMs = u === prevUrl ? 8000 : 5000;
      log(`  [loop ${i}] Not ad page — waiting ${waitMs / 1000}s...`);
      await sleep(waitMs);
    }
    prevUrl = u;
  }

  // bookyourhotel.in — final gateway
  let onHotel = false;
  for (let i = 0; i < 20; i++) {
    const u = page.url();
    if (u.includes("bookyourhotel.in")) { onHotel = true; break; }
    if (u.includes("vektalnodes.in")) break;
    await sleep(1000);
  }

  if (onHotel) {
    log(`\n── bookyourhotel.in — waiting countdown + 240s minimum ──`);

    // Wait for page countdown (30s floor)
    await waitForCountdown(page, 50000, "hotel", 30000);

    // Enforce 240s total from button click
    const elapsed = Math.floor((Date.now() - cycleStart) / 1000);
    if (elapsed < MIN_FLOW_S) {
      const need = (MIN_FLOW_S - elapsed) * 1000;
      log(`Total elapsed: ${elapsed}s — waiting ${MIN_FLOW_S - elapsed}s more for server minimum...`);
      await sleep(need);
    } else {
      log(`Total elapsed: ${elapsed}s — past 240s minimum ✓`);
    }

    // Click GET LINK (exact text match only)
    const gotLink = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a,button,input[type=button],input[type=submit]"));
      for (const el of all) {
        const txt = ((el.innerText || el.value || el.textContent) || "").trim().toLowerCase();
        if (txt === "get link" || txt === "get links" || txt === "getlink" || txt.startsWith("get link")) {
          el.click(); return el.innerText || el.value || txt;
        }
      }
      return null;
    }).catch(() => null);

    if (gotLink) log(`✓ Clicked GET LINK: "${gotLink}"`);
    else { log("✗ GET LINK not found — trying CSS fallback..."); await clickButton(page, ["#get-link",".get-link-btn","[id*='get-link']"], []); }

    await sleep(8000);
    log(`After GET LINK: ${page.url()}`);
  }

  // Wait for final redirect to vektalnodes.in/earn
  await sleep(5000);
  if (!page.url().includes("vektalnodes.in/earn")) {
    log("Navigating to /earn to confirm coin credit...");
    await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCF(page, 30000);
  }
  await sleep(2000);

  const coinsAfter = await getCoins(page);
  const statusAfter = await getLinkPaysStatus(page);
  const diff = coinsAfter - coinsBefore;

  log(`\nCoins BEFORE: ${coinsBefore} | AFTER: ${coinsAfter} | DIFF: +${diff}`);
  log(`Flash: ${statusAfter.flash || "(none)"}`);

  const success = diff > 0 || statusAfter.flash.includes("coin");
  if (success) log(`✅ CYCLE ${cycleNum} SUCCESS — +${diff} coins (total: ${coinsAfter})`);
  else         log(`⚠️  CYCLE ${cycleNum} — No coins detected. Flash: "${statusAfter.flash}"`);

  return { success, waitMs: 0, coinsAfter };
}

// ── AFK keep-alive (periodic mouse moves + page refresh) ─────────────────────
async function keepAliveOnce(page) {
  if (!page.url().includes("vektalnodes.in")) return;
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 300 + Math.random() * 200, clientY: 300 + Math.random() * 200 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
    try { Object.defineProperty(document, "hidden", { value: false, writable: true }); } catch {}
    try { Object.defineProperty(document, "visibilityState", { value: "visible", writable: true }); } catch {}
  }).catch(() => {});
  await page.mouse.move(200 + Math.random() * 400, 200 + Math.random() * 400);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  log("═══════════════════════════════════════════════");
  log("  AFK Bot — vektalnodes.in/earn              ");
  log("═══════════════════════════════════════════════");

  const chrome = findChrome();
  if (!chrome) { log("ERROR: Chrome/Chromium not found. Run start.sh first."); process.exit(1); }
  const snap = isSnap(chrome);
  log(`Chrome: ${chrome} (snap: ${snap})`);

  const xvfb = await startXvfb().catch((e) => { log(`Xvfb start failed: ${e.message}`); return null; });
  if (!process.env.DISPLAY && xvfb) process.env.DISPLAY = DISPLAY_NUM;
  log(`DISPLAY=${process.env.DISPLAY || "(none)"}`);

  const commonArgs = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
  ];
  const extraArgs = [
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
    const result = await connect({
      headless: false,
      args: snap ? [...extraArgs, ...commonArgs] : [...commonArgs],
      customConfig: { chromePath: chrome },
      turnstile: true,
      connectOption: { defaultViewport: { width: 1280, height: 900 } },
      disableXvfb: true,
      ignoreAllFlags: snap,
    });
    browser = result.browser;
    page    = result.page;
    page.setDefaultNavigationTimeout(90000);
    page.on("dialog", async (d) => { log(`Dialog: ${d.message()}`); await d.dismiss(); });
    log("Browser launched ✓");

    // Login
    await login(page);

    // Go to /earn
    if (!page.url().includes("/earn")) {
      await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForCF(page);
    }

    // ── Main loop ─────────────────────────────────────────────────────────
    let successCount = 0;
    let cycleNum     = 0;
    let afkTick      = 0;
    let nextCycleAt  = Date.now(); // run first cycle immediately

    log(`\nBot running. Will earn up to ${MAX_DAILY} × 12 = ${MAX_DAILY * 12} coins today.`);
    log("Press Ctrl+C to stop.\n");

    while (true) {
      const now = Date.now();

      // ── LinkPays cycle ────────────────────────────────────────────────
      if (successCount < MAX_DAILY && now >= nextCycleAt) {
        cycleNum++;
        try {
          const result = await runLinkPaysCycle(page, cycleNum);
          if (result.success) {
            successCount++;
            log(`Daily progress: ${successCount}/${MAX_DAILY} cycles complete`);
            if (successCount < MAX_DAILY) {
              nextCycleAt = Date.now() + COOLDOWN_MS;
              log(`Next cycle in ${Math.round(COOLDOWN_MS / 60000)}m (at ${new Date(nextCycleAt).toLocaleTimeString()})`);
            } else {
              log(`🎉 All ${MAX_DAILY} cycles done today — ${successCount * 12} coins earned!`);
              log("Switching to AFK-only mode until tomorrow.");
            }
          } else if (result.waitMs > 0) {
            nextCycleAt = Date.now() + result.waitMs;
            log(`Waiting ${Math.round(result.waitMs / 1000)}s before retry...`);
          } else {
            nextCycleAt = Date.now() + 60000;
          }
        } catch (err) {
          log(`Cycle ${cycleNum} ERROR: ${err.message}`);
          nextCycleAt = Date.now() + 60000;
        }

        // Return to /earn after cycle
        try {
          if (!page.url().includes("vektalnodes.in/earn")) {
            await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30000 });
            await waitForCF(page, 15000);
          }
        } catch {}
      }

      // ── AFK keep-alive tick (every 60s) ──────────────────────────────
      afkTick++;
      await keepAliveOnce(page).catch(() => {});

      // Reload /earn every tick to get fresh status
      try {
        if (!page.url().includes(`${SITE}/earn`)) {
          await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 30000 });
        } else {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        }
        await waitForCF(page, 10000);
      } catch {}

      // Read real usage + next slot from page
      const liveStatus = await getLinkPaysStatus(page).catch(() => null);
      const coins = await getCoins(page).catch(() => "?");
      const secUntilNext = Math.max(0, Math.round((nextCycleAt - Date.now()) / 1000));
      const usageStr = liveStatus ? `${liveStatus.usageToday}/${liveStatus.maxUsage}` : `${successCount}/${MAX_DAILY}`;
      log(`[AFK tick ${afkTick}] Coins: ${coins} | Usage: ${usageStr} | Next LP cycle: ${secUntilNext > 0 ? secUntilNext + "s" : "NOW"}`);

      // If page shows a "Next slot opens in Xh Ym" cooldown, sleep the bot for exactly that long
      if (liveStatus && liveStatus.cooldownSec > 0 && successCount < MAX_DAILY) {
        const slotMs = liveStatus.cooldownSec * 1000;
        const wakeAt = new Date(Date.now() + slotMs).toLocaleTimeString();
        log(`💤 Next slot opens in ${Math.floor(liveStatus.cooldownSec / 3600)}h ${Math.floor((liveStatus.cooldownSec % 3600) / 60)}m — sleeping until ${wakeAt}`);
        nextCycleAt = Date.now() + slotMs;
        await sleep(slotMs, "slot wait");
      } else {
        await sleep(60000);
      }
    }

  } catch (err) {
    log(`FATAL: ${err.message}`);
    console.error(err.stack);
    cleanup();
    process.exit(1);
  }
})();
