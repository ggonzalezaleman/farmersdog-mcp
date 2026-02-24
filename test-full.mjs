import { Solver } from "@2captcha/captcha-solver";
import { chromium } from "playwright";

const solver = new Solver("aef1d3955382cae2ab2738ea0843ef95");
const ws = "wss://connect.browserbase.com?apiKey=bb_live_A6_x3NwvdM9jmPRpA-cy3ipM7ts&projectId=9832dd11-afff-4de6-ada3-ccb40f2056cc";

console.log("1. Connecting to Browserbase...");
const browser = await chromium.connectOverCDP(ws);
const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();

console.log("2. Loading login page...");
await page.goto("https://www.thefarmersdog.com/login", { timeout: 60000 });
await page.waitForTimeout(5000);

// Solve Turnstile FIRST, then fill both fields after
console.log("4. Solving Turnstile via 2Captcha...");
const t0 = Date.now();
const result = await solver.cloudflareTurnstile({
  pageurl: "https://www.thefarmersdog.com/login",
  sitekey: "0x4AAAAAAAWwgggf84d3DU0J"
});
console.log(`   Solved in ${Math.round((Date.now() - t0) / 1000)}s`);

// Inject the token into the hidden field
console.log("5. Injecting Turnstile token...");
await page.evaluate((token) => {
  const input = document.querySelector('input[name="cf-turnstile-response"]');
  if (input) {
    input.value = token;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Also try the turnstile callback
  if (window.turnstile) {
    const widgets = document.querySelectorAll('.cf-turnstile, [data-turnstile]');
    widgets.forEach(w => {
      const id = w.getAttribute('data-widget-id');
      if (id) try { window.turnstile.getResponse = () => token; } catch {}
    });
  }
}, result.data);
await page.waitForTimeout(2000);

// Check button state
let btnOk = await page.evaluate(() => Array.from(document.querySelectorAll("button[type=submit]")).some(b => !b.disabled));
console.log("   Button enabled after inject:", btnOk);

if (!btnOk) {
  // Natural fallback
  console.log("   Waiting naturally...");
  for (let i = 0; i < 15; i++) {
    btnOk = await page.evaluate(() => Array.from(document.querySelectorAll("button[type=submit]")).some(b => !b.disabled));
    if (btnOk) { console.log(`   Natural pass at ${i*2}s`); break; }
    await page.waitForTimeout(2000);
  }
}

// Fill BOTH fields AFTER Turnstile (it clears everything on completion)
console.log("6. Filling email + password...");
await page.getByTestId("loginFormWebsite").getByRole("textbox", { name: "Email" }).click();
await page.keyboard.type("ggonzaleza@litebox.ai", { delay: 30 });
await page.getByTestId("loginFormWebsite").locator("input[type=password]").click();
await page.keyboard.type("nue0uqc3nyq4TJX_xju", { delay: 30 });

// Verify - specifically check the loginFormWebsite inputs
const fields = await page.evaluate(() => {
  const form = document.querySelector("[data-testid=loginFormWebsite]");
  if (!form) return { error: "no form found" };
  const emailInput = form.querySelector('input[name="Email"]') || form.querySelector("input[type=email]");
  const passInput = form.querySelector("input[type=password]");
  return {
    email: emailInput?.value || "",
    passLen: passInput?.value?.length || 0
  };
});
console.log("   Fields:", JSON.stringify(fields));
if (!fields.email || fields.passLen < 5) {
  console.log("   WARNING: fields not filled properly, retrying...");
  if (!fields.email) {
    await page.getByTestId("loginFormWebsite").getByRole("textbox", { name: "Email" }).click();
    await page.keyboard.type("ggonzaleza@litebox.ai", { delay: 20 });
  }
  if (fields.passLen < 5) {
    await page.getByTestId("loginFormWebsite").locator("input[type=password]").click();
    await page.keyboard.type("nue0uqc3nyq4TJX_xju", { delay: 20 });
  }
  await page.waitForTimeout(300);
}

// Submit
console.log("7. Submitting...");
await page.evaluate(() => {
  for (const b of document.querySelectorAll("button[type=submit]")) {
    if (!b.disabled) { b.click(); break; }
  }
});

try {
  await page.waitForURL("**/app/**", { timeout: 25000 });
  console.log("8. LOGIN SUCCESS!", page.url());
} catch {
  console.log("8. LOGIN FAILED. URL:", page.url());
  await browser.close();
  process.exit(1);
}

// === TEST ROUTE INTERCEPTION ===
console.log("\n9. Installing route interception...");
let resolveQuery;
let pendingSwap = null;

await page.route("**/core-api-customer.k8s.east.thefarmersdog.com/**", async (route) => {
  if (pendingSwap) {
    const swap = pendingSwap;
    pendingSwap = null;
    console.log("   INTERCEPTED! Swapping body...");
    await route.continue({
      postData: JSON.stringify({ query: swap.query, variables: swap.variables || {} }),
    });
  } else {
    await route.continue();
  }
});

page.on("response", async (r) => {
  if (!resolveQuery) return;
  if (!r.url().includes("core-api-customer")) return;
  try {
    const text = await r.text();
    const json = JSON.parse(text);
    if (json.data?.me?.subscriptions) {
      resolveQuery(json);
      resolveQuery = null;
    }
  } catch {}
});

const resultPromise = new Promise((res, rej) => {
  resolveQuery = res;
  setTimeout(() => rej(new Error("30s timeout")), 30000);
});

pendingSwap = { query: "{ me { subscriptions { id nextDate frequency status } } }" };
console.log("10. Triggering reload for interception...");
page.goto("https://www.thefarmersdog.com/app/home", { waitUntil: "commit" }).catch(() => {});

try {
  const data = await resultPromise;
  console.log("\n=== SUCCESS ===");
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.log("\nInterception failed:", e.message);
}

await browser.close();
