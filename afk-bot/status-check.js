require("dotenv").config();
const { connect } = require("puppeteer-real-browser");

const SITE = "https://vektalnodes.in";
const EMAIL = process.env.EMAIL || "";
const PASSWORD = process.env.PASSWORD || "";
const CHROME = process.env.CHROMIUM_PATH || "";

(async () => {
  console.log("Launching browser...");
  const { browser, page } = await connect({
    headless: false,
    disableXvfb: true,
    customConfig: { chromePath: CHROME },
    turnstile: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"],
    connectOption: { defaultViewport: { width: 1280, height: 900 } },
  });

  try {
    // Login
    console.log("Logging in...");
    await page.goto(SITE + "/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const emailEl = await page.$('input[type="email"], input[name="email"]');
    if (!emailEl) throw new Error("No email input found");
    await emailEl.type(EMAIL, { delay: 40 });

    const passEl = await page.$('input[type="password"]');
    if (!passEl) throw new Error("No password input found");
    await passEl.type(PASSWORD, { delay: 40 });
    await page.keyboard.press("Enter");
    await new Promise(r => setTimeout(r, 4000));

    // Navigate to /earn
    await page.goto(SITE + "/earn", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    console.log("On:", page.url());

    // Read coins
    const coins = await page.evaluate(() => {
      const el = document.querySelector(".topbar-pill strong");
      return el ? el.innerText.trim() : "?";
    }).catch(() => "?");
    console.log("Coin balance:", coins);

    // Read LinkPays status pills
    const status = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("article.offer-card"));
      let lpCard = null;
      for (const c of cards) {
        if ((c.textContent || "").toLowerCase().includes("linkpays")) { lpCard = c; break; }
      }
      if (!lpCard) return { error: "LinkPays card not found" };

      const btn = lpCard.querySelector('button.button-primary[type="submit"]');
      const pills = Array.from(lpCard.querySelectorAll(".status-pill"));
      const pillTexts = pills.map(p => p.innerText.trim());

      let usageToday = 0, maxUsage = 10, cooldownSec = 0;
      for (const text of pillTexts) {
        if (/usage/i.test(text)) {
          const m = text.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) { usageToday = parseInt(m[1]); maxUsage = parseInt(m[2]); }
        }
        const slotMatch = text.match(/next slot opens in\s*(?:(\d+)h)?\s*(?:(\d+)m)?/i);
        if (slotMatch) {
          const h = parseInt(slotMatch[1] || "0");
          const m2 = parseInt(slotMatch[2] || "0");
          cooldownSec = h * 3600 + m2 * 60;
        }
      }

      const available = !!btn && !btn.disabled;
      return { pillTexts, available, usageToday, maxUsage, cooldownSec };
    }).catch(e => ({ error: e.message }));

    console.log("\n=== LinkPays Status ===");
    console.log("Raw pills:", JSON.stringify(status.pillTexts));
    console.log("Available:", status.available);
    console.log("Usage:", status.usageToday + "/" + status.maxUsage);
    console.log("Cooldown:", status.cooldownSec + "s");

    if (status.cooldownSec > 0) {
      const h = Math.floor(status.cooldownSec / 3600);
      const m = Math.floor((status.cooldownSec % 3600) / 60);
      console.log("Bot would sleep:", h + "h " + m + "m (" + status.cooldownSec + "s)");
      console.log("Wake at:", new Date(Date.now() + status.cooldownSec * 1000).toLocaleTimeString());
    } else if (status.available) {
      console.log("Slot AVAILABLE — bot would start a cycle NOW");
    } else {
      console.log("Not available (daily limit hit or disabled)");
    }

  } finally {
    await browser.close();
    console.log("\nDone.");
  }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
