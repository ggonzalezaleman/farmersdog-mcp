import { Solver } from "@2captcha/captcha-solver";
import { chromium } from "playwright";

const solver = new Solver("aef1d3955382cae2ab2738ea0843ef95");
const ws = "wss://connect.browserbase.com?apiKey=bb_live_A6_x3NwvdM9jmPRpA-cy3ipM7ts&projectId=9832dd11-afff-4de6-ada3-ccb40f2056cc";

console.log("Connecting...");
const browser = await chromium.connectOverCDP(ws);
const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();

page.on("response", async r => {
  if (r.url().includes("core-api")) {
    try { console.log("API:", r.status(), (await r.text()).substring(0, 150)); } catch {}
  }
});

console.log("Loading login...");
await page.goto("https://www.thefarmersdog.com/login", { timeout: 60000 });
await page.waitForTimeout(5000);

// Password first
await page.getByTestId("loginFormWebsite").locator("input[type=password]").click();
await page.keyboard.type("nue0uqc3nyq4TJX_xju", { delay: 40 });

// Get sitekey from page
const sitekey = await page.evaluate(() => {
  const w = document.querySelector("[data-sitekey]");
  if (w) return w.getAttribute("data-sitekey");
  const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
  if (iframe) { const m = (iframe.getAttribute("src") || "").match(/[?&]k=([^&]+)/); if (m) return m[1]; }
  return null;
}) || "0x4AAAAAAA1dwgJRIjCpfp_v";
console.log("Sitekey:", sitekey);

// Solve Turnstile
console.log("Solving via 2Captcha...");
const t0 = Date.now();
const result = await solver.cloudflareTurnstile({ pageurl: "https://www.thefarmersdog.com/login", sitekey });
console.log(`Solved in ${Math.round((Date.now() - t0) / 1000)}s`);

// Inject
await page.evaluate((token) => {
  document.querySelectorAll('input[name*="turnstile"], input[name*="cf-"], input[name="cf-turnstile-response"]')
    .forEach(el => { el.value = token; });
  document.querySelectorAll("form").forEach(f => f.dispatchEvent(new Event("change", { bubbles: true })));
}, result.data);
await page.waitForTimeout(2000);

let btnOk = await page.evaluate(() => Array.from(document.querySelectorAll("button[type=submit]")).some(b => !b.disabled));
console.log("Button after inject:", btnOk);

if (!btnOk) {
  console.log("Waiting naturally...");
  for (let i = 0; i < 15; i++) {
    btnOk = await page.evaluate(() => Array.from(document.querySelectorAll("button[type=submit]")).some(b => !b.disabled));
    if (btnOk) { console.log(`Natural at ${i*2}s`); break; }
    await page.waitForTimeout(2000);
  }
}

// Email AFTER Turnstile
await page.getByTestId("loginFormWebsite").getByRole("textbox", { name: "Email" }).click();
await page.keyboard.type("ggonzaleza@litebox.ai", { delay: 30 });

// Verify
const fields = await page.evaluate(() => {
  const form = document.querySelector("[data-testid=loginFormWebsite]") || document;
  const e = form.querySelector("input[type=email]");
  const p = form.querySelector("input[type=password]");
  return { email: e?.value, passLen: p?.value?.length };
});
console.log("Fields:", JSON.stringify(fields));

// Submit
await page.evaluate(() => {
  for (const b of document.querySelectorAll("button[type=submit]")) { if (!b.disabled) { b.click(); break; } }
});

try {
  await page.waitForURL("**/app/**", { timeout: 25000 });
  console.log("LOGIN SUCCESS!", page.url());

  // TEST: route interception
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  
  await page.route("**/core-api-customer.k8s.east.thefarmersdog.com/**", async (route) => {
    console.log("INTERCEPTED, swapping body...");
    await route.continue({
      postData: JSON.stringify({ query: "{ me { subscriptions { id nextDate frequency status } } }" }),
    });
  });

  page.on("response", async r => {
    if (r.url().includes("core-api-customer") && r.url().includes("graphql")) {
      try {
        const text = await r.text();
        const json = JSON.parse(text);
        if (json.data?.me?.subscriptions) {
          resolve(json);
        }
      } catch {}
    }
  });

  page.goto("https://www.thefarmersdog.com/app/home", { waitUntil: "commit" }).catch(() => {});
  const result2 = await Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("30s timeout")), 30000))]);
  console.log("\n=== INTERCEPTION RESULT ===");
  console.log(JSON.stringify(result2, null, 2));
} catch (e) {
  console.log("FAILED:", e.message);
  console.log("URL:", page.url());
}

await browser.close();
