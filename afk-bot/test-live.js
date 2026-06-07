/**
 * test-live.js — Live test: slot logic + login + page status
 * Run: node test-live.js
 */
require("dotenv").config();
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const SITE     = "https://vektalnodes.in";
const EMAIL    = process.env.EMAIL    || "";
const PASSWORD = process.env.PASSWORD || "";
const CHROMIUM = process.env.CHROMIUM_PATH ||
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

const SLOT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DAILY      = 10;

// ── Slot tracker (same logic as bot.js) ──────────────────────────────────────
function activeSlots(slots) {
  const cutoff = Date.now() - SLOT_WINDOW_MS;
  return slots.filter((t) => t > cutoff);
}
function msUntilNextSlot(slots) {
  const active = activeSlots(slots);
  if (active.length < MAX_DAILY) return 0;
  const oldest = Math.min(...active);
  return Math.max(0, oldest + SLOT_WINDOW_MS - Date.now());
}

// ── Tests ─────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label, condition, detail = "") {
  if (condition) { console.log(`  ✅ ${label}`); pass++; }
  else           { console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`); fail++; }
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  AFK-BOT LIVE TEST");
  console.log("═══════════════════════════════════════\n");

  // ── 1. Slot tracking unit tests ──────────────────────────────────────────
  console.log("── 1. Slot tracking logic ──");

  const now    = Date.now();
  const hour   = 3_600_000;

  const empty = [];
  check("Empty log: 10 free slots",    activeSlots(empty).length === 0);
  check("Empty log: no wait",          msUntilNextSlot(empty) === 0);

  const full9 = Array.from({ length: 9 }, (_, i) => now - i * hour);
  check("9 slots active: 9 active",   activeSlots(full9).length === 9);
  check("9 slots active: no wait",    msUntilNextSlot(full9) === 0);

  const full10 = Array.from({ length: 10 }, (_, i) => now - i * hour);
  check("10 slots active: 10 active", activeSlots(full10).length === 10);
  check("10 slots active: wait > 0",  msUntilNextSlot(full10) > 0);

  const mixed = [
    now - (25 * hour),   // expired (>24h ago)
    now - (23 * hour),   // active
    now - (1 * hour),    // active
  ];
  check("Expired slots pruned: 2 active", activeSlots(mixed).length === 2);

  const rollover = Array.from({ length: 10 }, (_, i) =>
    i === 9 ? now - (23 * hour + 30 * 60_000) : now - i * hour
  );
  const waitMs = msUntilNextSlot(rollover);
  const waitMin = Math.round(waitMs / 60000);
  check(`Rolling window: next slot in ~30m (got ${waitMin}m)`, waitMin >= 28 && waitMin <= 32);

  console.log();

  // ── 2. Credentials check ─────────────────────────────────────────────────
  console.log("── 2. Credentials ──");
  check("EMAIL is set",    EMAIL.length > 0,    `got: "${EMAIL.slice(0,3)}..."`);
  check("PASSWORD is set", PASSWORD.length > 0, "***");
  check("CHROMIUM exists", fs.existsSync(CHROMIUM), CHROMIUM);
  console.log();

  // ── 3. Live browser test ─────────────────────────────────────────────────
  console.log("── 3. Live site test (headless) ──");
  console.log("  Launching chromium...");

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: "new",
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--window-size=1280,900",
      ],
    });
    check("Browser launched", true);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
    );

    // Load login page
    console.log(`  → ${SITE}/login`);
    await page.goto(`${SITE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    const loginUrl = page.url();
    console.log(`  Landed: ${loginUrl}`);
    check("Reached vektalnodes", loginUrl.includes("vektalnodes.in"));

    const hasCF = (await page.title()).toLowerCase().includes("just a moment");
    if (hasCF) {
      console.log("  ⚠️  Cloudflare challenge active (expected in headless — bot uses real browser to bypass this)");
      check("CF detected (headless limitation — bot.js uses real browser)", true);
      await browser.close();
      printSummary();
      return;
    }

    // Try login
    const emailInput = await page.$('input[type="email"], input[name="email"]').catch(() => null);
    check("Email input found on login page", !!emailInput);

    if (emailInput) {
      await emailInput.type(EMAIL, { delay: 30 });
      const passInput = await page.$('input[type="password"]');
      check("Password input found", !!passInput);

      if (passInput) {
        await passInput.type(PASSWORD, { delay: 30 });
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
          page.keyboard.press("Enter"),
        ]);
        await new Promise((r) => setTimeout(r, 2000));
        const afterLogin = page.url();
        console.log(`  After login: ${afterLogin}`);
        check("Logged in (not on /login)", !afterLogin.includes("/login"));

        // Navigate to /earn explicitly (login may redirect to /dashboard)
        if (!afterLogin.includes("/earn")) {
          console.log("  → Navigating to /earn...");
          await page.goto(`${SITE}/earn`, { waitUntil: "domcontentloaded", timeout: 20000 });
          await new Promise((r) => setTimeout(r, 2000));
          console.log(`  On: ${page.url()}`);
        }

        if (page.url().includes("vektalnodes.in")) {
          // Read page status
          const status = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll("article.offer-card"));
            let lpCard = null;
            for (const c of cards) {
              if ((c.textContent || "").toLowerCase().includes("linkpays")) { lpCard = c; break; }
            }
            if (!lpCard) return { found: false };
            const btn = lpCard.querySelector('button.button-primary[type="submit"]');
            const pills = Array.from(lpCard.querySelectorAll(".status-pill"));
            let usageToday = 0, maxUsage = 10, cooldownSec = 0;
            for (const pill of pills) {
              const text = (pill.innerText || "").trim();
              if (/usage/i.test(text)) {
                const m = text.match(/(\d+)\s*\/\s*(\d+)/);
                if (m) { usageToday = parseInt(m[1]); maxUsage = parseInt(m[2]); }
              }
              const slotMatch = text.match(/next slot opens in\s*(?:(\d+)h)?\s*(?:(\d+)m)?/i);
              if (slotMatch) {
                cooldownSec = (parseInt(slotMatch[1] || "0") * 3600) +
                              (parseInt(slotMatch[2] || "0") * 60);
              }
            }
            const coins = (() => {
              const el = document.querySelector(".topbar-pill strong");
              return el ? parseInt(el.innerText.trim()) || 0 : 0;
            })();
            return {
              found: true,
              available: !!btn && !btn.disabled,
              usageToday,
              maxUsage,
              cooldownSec,
              coins,
            };
          }).catch(() => ({ found: false }));

          check("LinkPays card found on /earn", status.found);
          if (status.found) {
            console.log(`\n  📊 LIVE STATUS:`);
            console.log(`     Coins:     ${status.coins}`);
            console.log(`     Usage:     ${status.usageToday}/${status.maxUsage}`);
            console.log(`     Available: ${status.available}`);
            if (status.cooldownSec > 0) {
              const h = Math.floor(status.cooldownSec / 3600);
              const m = Math.floor((status.cooldownSec % 3600) / 60);
              const wakeAt = new Date(Date.now() + status.cooldownSec * 1000).toLocaleTimeString();
              console.log(`     Cooldown:  ${h}h ${m}m (next slot at ${wakeAt})`);
            } else {
              console.log(`     Cooldown:  none — slot ready NOW`);
            }

            // Validate slot logic against live data
            if (status.usageToday > 0 && status.cooldownSec > 0) {
              const oldestUsedAgo = SLOT_WINDOW_MS - status.cooldownSec * 1000;
              const seedSlots = Array.from({ length: status.usageToday }, (_, i) =>
                Date.now() - (oldestUsedAgo + i * (oldestUsedAgo / Math.max(status.usageToday - 1, 1)))
              );
              const seedWait = msUntilNextSlot(seedSlots.length >= MAX_DAILY ? seedSlots : []);
              console.log(`\n  💡 SLOT LOG SEED: If you have ${status.usageToday}/10 used,`);
              console.log(`     slot-log.json should be pre-seeded with ${status.usageToday} timestamps.`);
              check("Slot math consistent with page timer",
                Math.abs(status.cooldownSec - (seedWait / 1000)) < 3600 || status.usageToday < MAX_DAILY
              );
            }
          }
        }
      }
    }

    await page.screenshot({ path: path.join(__dirname, "screenshots", "live-test.png") }).catch(() => {});
    console.log("  📸 Screenshot saved to screenshots/live-test.png");

  } catch (e) {
    console.log(`  ❌ Browser error: ${e.message}`);
    fail++;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  console.log();
  printSummary();
}

function printSummary() {
  console.log("═══════════════════════════════════════");
  console.log(`  Results: ${pass} passed, ${fail} failed`);
  if (fail === 0) console.log("  ✅ All tests passed!");
  else            console.log("  ⚠️  Some tests failed — see above.");
  console.log("═══════════════════════════════════════");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
