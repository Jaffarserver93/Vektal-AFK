require("dotenv").config();
const puppeteer = require("puppeteer");

const BASE_URL = "https://vektalnodes.in";
const LOGIN_URL = `${BASE_URL}/earn`;
const EARN_URL = `${BASE_URL}/earn`;

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("[ERROR] EMAIL and PASSWORD must be set in .env file");
  process.exit(1);
}

function log(msg) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${msg}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryLogin(page) {
  log("Attempting login...");

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[placeholder*="email" i]',
    'input[id*="email" i]',
    'input[id*="user" i]',
  ];

  const passwordSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="password" i]',
    'input[id*="password" i]',
  ];

  let emailField = null;
  for (const sel of emailSelectors) {
    try {
      emailField = await page.$(sel);
      if (emailField) { log(`Found email field: ${sel}`); break; }
    } catch {}
  }

  let passwordField = null;
  for (const sel of passwordSelectors) {
    try {
      passwordField = await page.$(sel);
      if (passwordField) { log(`Found password field: ${sel}`); break; }
    } catch {}
  }

  if (!emailField || !passwordField) {
    log("Could not find login fields.");
    return false;
  }

  await emailField.click({ clickCount: 3 });
  await emailField.type(EMAIL, { delay: 80 });
  await sleep(400);

  await passwordField.click({ clickCount: 3 });
  await passwordField.type(PASSWORD, { delay: 80 });
  await sleep(400);

  let submitBtn = null;
  for (const sel of ['button[type="submit"]', 'input[type="submit"]', "form button"]) {
    try {
      submitBtn = await page.$(sel);
      if (submitBtn) { log(`Found submit button: ${sel}`); break; }
    } catch {}
  }

  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passwordField.press("Enter");
  }

  log("Waiting for navigation after login...");
  await sleep(5000);

  const url = page.url();
  log(`After login, current URL: ${url}`);
  return true;
}

async function clickAfkIfAvailable(page) {
  const afkSelectors = [
    'a[href*="afk" i]',
    'button:has-text("AFK")',
    '[class*="afk" i]',
    '[id*="afk" i]',
    'a[href*="/afk"]',
  ];

  for (const sel of afkSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        log(`Found AFK element (${sel}), clicking it...`);
        await el.click();
        await sleep(3000);
        return true;
      }
    } catch {}
  }
  return false;
}

async function keepAlive(page) {
  log("Starting AFK keep-alive loop (every 30s)...");
  log("=========================================");

  let tick = 0;
  while (true) {
    tick++;
    try {
      const url = page.url();

      if (!url.includes("vektalnodes.in")) {
        log("Unexpected redirect, going back to earn page...");
        await page.goto(EARN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(3000);
        continue;
      }

      if (url.includes("/login")) {
        log("Session expired — re-logging in...");
        const ok = await tryLogin(page);
        if (ok) {
          await sleep(3000);
          await page.goto(EARN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
          await sleep(3000);
        }
        continue;
      }

      await page.evaluate(() => {
        window.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 200 + Math.floor(Math.random() * 300),
          clientY: 200 + Math.floor(Math.random() * 300),
        }));
        document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
        Object.defineProperty(document, "hidden", { value: false, writable: true });
        Object.defineProperty(document, "visibilityState", { value: "visible", writable: true });
      });

      await page.mouse.move(
        200 + Math.floor(Math.random() * 300),
        200 + Math.floor(Math.random() * 300)
      );

      const title = await page.title().catch(() => "unknown");
      log(`[Tick ${tick}] Active — "${title}" | ${url}`);

      if (tick % 5 === 0) {
        log("Reloading earn page to keep session fresh...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(3000);
      }
    } catch (err) {
      log(`[Tick ${tick}] Error: ${err.message} — retrying next cycle`);
    }

    await sleep(30000);
  }
}

(async () => {
  log("=== AFK Bot Starting ===");
  log(`Target: ${BASE_URL}`);

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.CHROMIUM_PATH || "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--window-size=1280,800",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  page.on("dialog", async (dialog) => {
    log(`Auto-dismissing dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });

  process.on("SIGINT", async () => {
    log("Shutting down bot...");
    await browser.close();
    process.exit(0);
  });

  try {
    log(`Opening ${LOGIN_URL} ...`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    const currentUrl = page.url();
    log(`Landed on: ${currentUrl}`);

    const pageContent = await page.content();
    const needsLogin = pageContent.includes('type="password"') || currentUrl.includes("/login");

    if (needsLogin) {
      await tryLogin(page);
    } else {
      log("Already logged in, skipping login step.");
    }

    await sleep(2000);

    const postLoginUrl = page.url();
    log(`Session established. Current page: ${postLoginUrl}`);

    const afkFound = await clickAfkIfAvailable(page);
    if (!afkFound) {
      log("No AFK button found — staying on earn page and keeping session alive.");
    }

    await keepAlive(page);
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    await browser.close();
    process.exit(1);
  }
})();
