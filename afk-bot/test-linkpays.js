require("dotenv").config();
const puppeteer = require("puppeteer");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR);

const CHROME_ARGS = [
  "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
  "--disable-gpu", "--disable-accelerated-2d-canvas", "--no-first-run",
  "--no-zygote", "--single-process", "--disable-extensions",
  "--disable-background-networking", "--disable-default-apps",
  "--disable-sync", "--disable-translate", "--hide-scrollbars",
  "--mute-audio", "--window-size=1280,800",
];

function findChrome() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium",
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
  ];
  for (const p of candidates) { try { execSync(`test -x "${p}"`); return p; } catch {} }
  for (const cmd of ["google-chrome-stable", "google-chrome", "chromium"]) {
    try { const p = execSync(`which ${cmd} 2>/dev/null`).toString().trim(); if (p && !p.includes("snap")) return p; } catch {}
  }
  return null;
}

let stepNum = 0;
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
async function sleep(ms, label) {
  if (label) log(`  ⏳ Waiting ${ms / 1000}s — ${label}...`);
  return new Promise((r) => setTimeout(r, ms));
}
async function shot(page, label) {
  stepNum++;
  const file = path.join(SCREENSHOTS_DIR, `${String(stepNum).padStart(2, "0")}-${label}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); } catch {}
  log(`  📸 ${path.basename(file)}`);
}

async function waitForVisible(page, selector, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const visible = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.offsetParent !== null;
    }, selector).catch(() => false);
    if (visible) return true;
    await sleep(1000);
  }
  return false;
}

async function clickSelector(page, selector, label) {
  try {
    const el = await page.$(selector);
    if (el) {
      await el.scrollIntoView().catch(() => {});
      await el.click();
      log(`  ✓ Clicked ${label} (${selector})`);
      return true;
    }
  } catch {}
  log(`  ✗ ${label} not found (${selector})`);
  return false;
}

// Handles one ad-page that has tp-unlock-btn / tp-btn pattern
async function handleAdPage(page, label) {
  log(`\n── Ad page [${label}] — ${page.url()} ──`);
  await shot(page, `adpage-${label}-start`);

  // Wait up to 25s for the "I'M Not Robot" button to appear
  log("  Waiting up to 25s for timer + 'I'M Not Robot' button...");
  const notRobotVisible = await waitForVisible(page, "button.tp-unlock-btn", 25000);

  if (notRobotVisible) {
    log("  'I'M Not Robot' button is visible!");
    await clickSelector(page, "button.tp-unlock-btn", "I'M Not Robot");
    await sleep(2000);
    await shot(page, `adpage-${label}-after-notrobot`);
  } else {
    log("  'I'M Not Robot' button did NOT appear — skipping.");
  }

  // Scroll to bottom to reveal hidden buttons
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1500);
  await shot(page, `adpage-${label}-scrolled`);

  // Wait for Verify button
  const verifyVisible = await waitForVisible(page, "button.tp-btn.tp-blue", 10000);
  if (verifyVisible) {
    // Click Verify (first tp-btn)
    const tpBtns = await page.$$("button.tp-btn.tp-blue");
    for (const btn of tpBtns) {
      const txt = (await btn.evaluate((el) => el.innerText)).toLowerCase();
      if (txt.includes("verify")) {
        await btn.click();
        log("  ✓ Clicked Verify button");
        await sleep(2000);
        break;
      }
    }
    await shot(page, `adpage-${label}-after-verify`);

    // Click Continue button
    const tpBtns2 = await page.$$("button.tp-btn.tp-blue");
    for (const btn of tpBtns2) {
      const txt = (await btn.evaluate((el) => el.innerText)).toLowerCase();
      if (txt.includes("continue")) {
        await btn.click();
        log("  ✓ Clicked Continue button");
        await sleep(4000);
        break;
      }
    }
  } else {
    // No tp-btn — look for any continue link
    log("  No tp-btn found — looking for any 'Continue' link...");
    const found = await page.evaluate(() => {
      const all = document.querySelectorAll("a, button");
      for (const el of all) {
        const txt = (el.innerText || "").trim().toLowerCase();
        if (txt === "continue" || txt === "next" || txt === "proceed") {
          el.click();
          return el.innerText;
        }
      }
      return null;
    });
    if (found) log(`  ✓ Clicked fallback: ${found}`);
    else log("  ✗ No continue button found on this page");
    await sleep(4000);
  }

  log(`  → After continue: ${page.url()}`);
  await shot(page, `adpage-${label}-after-continue`);
}

async function isAdPage(page) {
  return page.evaluate(() => {
    return !!(
      document.querySelector("button.tp-unlock-btn") ||
      document.querySelector("button.tp-btn") ||
      document.querySelector(".tp-unlock-btn") ||
      document.querySelector("[class*='tp-']")
    );
  }).catch(() => false);
}

(async () => {
  const startTime = Date.now();
  log("=== LinkPays Bypass Test v3 ===");

  const chrome = findChrome();
  if (!chrome) { log("No Chrome found."); process.exit(1); }
  log(`Chrome: ${chrome}`);

  const browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: CHROME_ARGS });
  const earnPage = await browser.newPage();
  await earnPage.setViewport({ width: 1280, height: 800 });
  earnPage.setDefaultNavigationTimeout(90000);
  await earnPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  earnPage.on("dialog", async (d) => { log(`Dialog: ${d.message()}`); await d.dismiss(); });

  try {
    // ── STEP 1: Login ──
    log("\n── STEP 1: Login ──");
    await earnPage.goto("https://vektalnodes.in/earn", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);
    if ((await earnPage.content()).includes('type="password"')) {
      await (await earnPage.$('input[type="email"]')).type(process.env.EMAIL, { delay: 60 });
      await (await earnPage.$('input[type="password"]')).type(process.env.PASSWORD, { delay: 60 });
      await (await earnPage.$('button[type="submit"]')).click();
      await sleep(5000);
    }
    log(`  ✓ Logged in: ${earnPage.url()}`);
    await shot(earnPage, "earn-page");

    // ── STEP 2: Open LinkPays flow page ──
    log("\n── STEP 2: Open LinkPays ──");

    // Click button — this fires POST /earn/linkpays/start AND opens new tab
    await earnPage.click("button.button-primary");
    log("  Clicked button.button-primary (POST /earn/linkpays/start fired)");

    // Wait 8s for the new tab + Cloudflare challenge to settle
    await sleep(8000, "new tab + Cloudflare to load");

    // Find the real linkpays.in page (not about:blank, not earn page)
    let flowPage = null;
    const allPages = await browser.pages();
    log(`  Open pages: ${allPages.map((p) => p.url()).join(" | ")}`);
    for (const p of allPages) {
      const u = p.url();
      if (u !== "about:blank" && !u.includes("vektalnodes.in") && u !== "") {
        flowPage = p;
        log(`  ✓ Found flow page: ${u}`);
        break;
      }
    }

    if (!flowPage) {
      // The linkpays.in page might still be loading — wait more
      log("  No flow page yet — waiting 10 more seconds...");
      await sleep(10000);
      const pages2 = await browser.pages();
      log(`  Pages now: ${pages2.map((p) => p.url()).join(" | ")}`);
      flowPage = pages2.find((p) => {
        const u = p.url();
        return u !== "about:blank" && !u.includes("vektalnodes.in") && u !== "";
      }) || null;
    }

    if (flowPage) {
      await flowPage.setViewport({ width: 1280, height: 800 });
      flowPage.setDefaultNavigationTimeout(90000);
      await flowPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
      flowPage.on("dialog", async (d) => { log(`Dialog: ${d.message()}`); await d.dismiss(); });
    } else {
      log("  Still no flow page — creating new page and navigating directly");
      flowPage = await browser.newPage();
      await flowPage.setViewport({ width: 1280, height: 800 });
      await flowPage.goto("https://linkpays.in/VEKTALNODES_COINS", { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(3000);
    }

    await sleep(2000);
    log(`  Flow page URL: ${flowPage.url()}`);
    await shot(flowPage, "linkpays-page");

    // ── STEP 3: linkpays.in — Click "Continue to Next" ──
    log("\n── STEP 3: linkpays.in — Continue to Next ──");
    const continueBtnVisible = await waitForVisible(flowPage, "button.btn, a.btn", 10000);
    log(`  Continue button visible: ${continueBtnVisible}`);

    await clickSelector(flowPage, "button.btn", "Continue to Next");
    await sleep(5000);
    log(`  After continue: ${flowPage.url()}`);
    await shot(flowPage, "after-linkpays-continue");

    // ── STEPS 4+: Loop through all ad pages ──
    log("\n── STEPS 4+: Ad page loop ──");
    for (let pageNum = 1; pageNum <= 6; pageNum++) {
      const url = flowPage.url();
      log(`\n  Page ${pageNum} URL: ${url}`);

      if (url.includes("vektalnodes.in")) {
        log("  → Back on vektalnodes.in — flow complete!");
        break;
      }
      if (url.includes("bookyourhotel.in") || url.includes("linkpays.in")) {
        log("  → On final gateway page, breaking ad loop.");
        break;
      }

      // Google vignette: URL has #google_vignette — just wait for auto-redirect
      if (url.includes("#google_vignette") || url.includes("google_vignette")) {
        log("  Google vignette detected — waiting for auto-redirect...");
        await sleep(8000);
        log(`  After vignette: ${flowPage.url()}`);
        continue;
      }

      let isAd = false;
      try { isAd = await isAdPage(flowPage); } catch {}
      log(`  Has tp- buttons: ${isAd}`);

      if (isAd) {
        await handleAdPage(flowPage, `p${pageNum}`);
      } else {
        log("  Not an ad page — waiting 5s for auto-redirect...");
        await sleep(5000);
        log(`  After wait: ${flowPage.url()}`);
      }
    }

    // ── STEP: bookyourhotel.in or linkpays gateway ──
    log("\n── Gateway page (hotel/linkpays) ──");

    // Wait up to 30s for the correct bookyourhotel URL with ?link= param
    log("  Waiting for bookyourhotel.in/?link= URL...");
    for (let i = 0; i < 30; i++) {
      const u = flowPage.url();
      if (u.includes("bookyourhotel.in") && u.includes("link=")) {
        log(`  ✓ Got correct URL: ${u}`);
        break;
      }
      if (u.includes("linkpays.in")) {
        log(`  ✓ Already on linkpays: ${u}`);
        break;
      }
      if (u.includes("vektalnodes.in")) {
        log(`  ✓ Back on vektalnodes — flow may be complete: ${u}`);
        break;
      }
      await sleep(1000);
    }

    const gatewayUrl = flowPage.url();
    log(`  URL: ${gatewayUrl}`);
    await shot(flowPage, "gateway-start");

    // Must wait until 240s+ elapsed
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minRequired = 245;
    if (elapsed < minRequired) {
      const waitMs = (minRequired - elapsed) * 1000;
      log(`  Elapsed: ${elapsed}s — waiting ${minRequired - elapsed}s more for 240s minimum...`);
      await sleep(waitMs, "240s minimum");
    } else {
      log(`  Elapsed: ${elapsed}s — past minimum. Waiting 30s for page timer...`);
      await sleep(30000, "page timer");
    }

    await shot(flowPage, "gateway-after-wait");

    // Click Get Link button (exact class match)
    const gotLink = await clickSelector(flowPage, "button.tp-btn, .get-link-btn, #get-link, button[class*='get']", "Get Link (css)");
    if (!gotLink) {
      // Text search with exact match only
      const found = await flowPage.evaluate(() => {
        const all = document.querySelectorAll("a, button");
        for (const el of all) {
          const txt = (el.innerText || "").trim().toLowerCase();
          if (txt === "get link" || txt === "get links" || txt === "claim" || txt === "proceed") {
            el.click();
            return el.innerText;
          }
        }
        return null;
      });
      log(found ? `  ✓ Clicked: ${found}` : "  ✗ Get Link not found");
    }

    await sleep(5000);
    log(`  After Get Link: ${flowPage.url()}`);
    await shot(flowPage, "after-get-link");

    await sleep(5000);
    log(`\n  Final URL: ${flowPage.url()}`);
    await shot(flowPage, "final");

    const total = Math.floor((Date.now() - startTime) / 1000);
    log(`\n=== Test complete in ${total}s ===`);
    log(`📁 Screenshots: ${SCREENSHOTS_DIR}`);

  } catch (err) {
    log(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    try {
      const pages = await browser.pages();
      for (const p of pages) {
        await p.screenshot({ path: path.join(SCREENSHOTS_DIR, `fatal-${p.url().replace(/\//g, "_").substring(0, 30)}.png`), fullPage: true }).catch(() => {});
      }
    } catch {}
  }

  await browser.close();
})();
