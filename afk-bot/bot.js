require("dotenv").config();
const puppeteer = require("puppeteer");

const BASE_URL = "https://vektalnodes.in";
const LOGIN_URL = `${BASE_URL}/earn`;
const AFK_URL = `${BASE_URL}/afk`;

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
    'input[placeholder*="Email" i]',
    'input[id*="email" i]',
    'input[id*="user" i]',
  ];

  const passwordSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="password" i]',
    'input[id*="password" i]',
  ];

  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:contains("Login")',
    'button:contains("Sign in")',
    'button:contains("Log in")',
    '[class*="login" i] button',
    '[class*="submit" i]',
    "form button",
  ];

  let emailField = null;
  for (const sel of emailSelectors) {
    try {
      emailField = await page.$(sel);
      if (emailField) {
        log(`Found email field: ${sel}`);
        break;
      }
    } catch {}
  }

  let passwordField = null;
  for (const sel of passwordSelectors) {
    try {
      passwordField = await page.$(sel);
      if (passwordField) {
        log(`Found password field: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!emailField) {
    log("Could not find email/username field on page.");
    log("Current page HTML snippet:");
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
    console.log(html);
    return false;
  }

  if (!passwordField) {
    log("Could not find password field on page.");
    return false;
  }

  await emailField.click({ clickCount: 3 });
  await emailField.type(EMAIL, { delay: 80 });
  await sleep(500);

  await passwordField.click({ clickCount: 3 });
  await passwordField.type(PASSWORD, { delay: 80 });
  await sleep(500);

  let submitBtn = null;
  for (const sel of submitSelectors) {
    try {
      submitBtn = await page.$(sel);
      if (submitBtn) {
        log(`Found submit button: ${sel}`);
        break;
      }
    } catch {}
  }

  if (submitBtn) {
    await submitBtn.click();
  } else {
    log("No submit button found, pressing Enter on password field...");
    await passwordField.press("Enter");
  }

  log("Waiting for navigation after login...");
  await sleep(4000);

  const url = page.url();
  log(`After login, current URL: ${url}`);
  return true;
}

async function keepAfkAlive(page) {
  log("Starting AFK keep-alive loop...");

  let tick = 0;
  while (true) {
    tick++;
    try {
      const url = page.url();

      if (!url.includes("vektalnodes.in")) {
        log("Unexpected page, navigating back to AFK...");
        await page.goto(AFK_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(3000);
        continue;
      }

      if (!url.includes("/afk")) {
        log(`Not on AFK page (${url}), navigating to /afk...`);
        await page.goto(AFK_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(3000);
        continue;
      }

      await page.evaluate(() => {
        window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: Math.random() * 500, clientY: Math.random() * 500 }));
        document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
      });

      await page.mouse.move(
        200 + Math.floor(Math.random() * 200),
        200 + Math.floor(Math.random() * 200)
      );

      const title = await page.title().catch(() => "unknown");
      log(`[Tick ${tick}] AFK active — page: "${title}" | url: ${url}`);
    } catch (err) {
      log(`[Tick ${tick}] Error in keep-alive: ${err.message}`);
    }

    await sleep(30000);
  }
}

(async () => {
  log("Launching browser...");

  const browser = await puppeteer.launch({
    headless: "new",
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

  try {
    log(`Navigating to ${LOGIN_URL} ...`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    const currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);

    const isAlreadyLoggedIn =
      currentUrl.includes("/dashboard") ||
      currentUrl.includes("/earn") && !currentUrl.includes("login");

    let loginDone = false;

    const pageContent = await page.content();
    const hasLoginForm =
      pageContent.includes('type="password"') ||
      pageContent.includes("login") ||
      pageContent.includes("signin");

    if (hasLoginForm) {
      loginDone = await tryLogin(page);
    } else {
      log("No login form detected — assuming already logged in or not needed.");
      loginDone = true;
    }

    if (!loginDone) {
      log("[WARN] Login may have failed. Attempting to proceed to /afk anyway...");
    }

    await sleep(2000);

    log(`Navigating to AFK page: ${AFK_URL}`);
    await page.goto(AFK_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3000);

    const afkUrl = page.url();
    const afkTitle = await page.title().catch(() => "unknown");
    log(`On page: "${afkTitle}" — ${afkUrl}`);

    if (!afkUrl.includes("/afk")) {
      log("[WARN] Not on /afk page. The bot will keep trying to stay on it.");
    }

    await keepAfkAlive(page);
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    await browser.close();
    process.exit(1);
  }
})();
