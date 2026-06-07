require("dotenv").config();
const puppeteer = require("puppeteer");
const { execSync } = require("child_process");

function findChrome() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium",
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
  ];
  for (const p of candidates) { try { execSync(`test -x "${p}"`); return p; } catch {} }
  return null;
}

const ARGS = [
  "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
  "--disable-gpu", "--no-first-run", "--no-zygote", "--single-process",
  "--disable-extensions", "--window-size=1280,800",
];

(async () => {
  const browser = await puppeteer.launch({ headless: "new", executablePath: findChrome(), args: ARGS });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  // Capture ALL requests when button is clicked
  const captured = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    const skip = ["analytics", "google-analytics", "gtag", ".css", ".woff", ".png", ".jpg", ".svg", ".ico", "fonts.g"];
    if (!skip.some((s) => url.includes(s))) {
      captured.push(`${req.method()} ${url}`);
    }
    req.continue();
  });

  // Watch for new targets (tabs/windows)
  browser.on("targetcreated", async (target) => {
    console.log(`\n🆕 NEW TAB/WINDOW CREATED: type=${target.type()} url=${target.url()}`);
    // Wait for it to navigate
    setTimeout(async () => {
      try {
        console.log(`   → Eventually became: ${target.url()}`);
      } catch {}
    }, 3000);
  });

  console.log("Navigating to earn page...");
  await page.goto("https://vektalnodes.in/earn", { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));

  if ((await page.content()).includes('type="password"')) {
    console.log("Logging in...");
    await (await page.$('input[type="email"]')).type(process.env.EMAIL, { delay: 50 });
    await (await page.$('input[type="password"]')).type(process.env.PASSWORD, { delay: 50 });
    await (await page.$('button[type="submit"]')).click();
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log("Logged in. URL:", page.url());

  // Inspect the button in detail
  const btnInfo = await page.evaluate(() => {
    const btns = document.querySelectorAll("button, a");
    for (const b of btns) {
      if ((b.innerText || "").toLowerCase().includes("linkpays")) {
        const attrs = {};
        for (const a of b.attributes) attrs[a.name] = a.value;
        return {
          tag: b.tagName,
          text: b.innerText.trim(),
          attrs,
          outerHTML: b.outerHTML.substring(0, 600),
        };
      }
    }
    return null;
  });
  console.log("\n=== LinkPays Button Info ===");
  console.log(JSON.stringify(btnInfo, null, 2));

  // Clear captured requests before click
  captured.length = 0;
  console.log("\n=== Clicking button — watching network ===");

  await page.click("button.button-primary");
  await new Promise((r) => setTimeout(r, 6000));

  console.log("\n=== Requests made on click ===");
  captured.forEach((r) => console.log(" ", r));

  // Check all open pages
  const pages = await browser.pages();
  console.log(`\n=== All open pages (${pages.length}) ===`);
  for (const p of pages) {
    console.log(" ", p.url());
  }

  await browser.close();
})().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
