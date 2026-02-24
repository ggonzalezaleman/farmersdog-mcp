#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, Browser, Page, Route } from "playwright";
import { Solver } from "@2captcha/captcha-solver";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const GRAPHQL_URL = "https://core-api-customer.k8s.east.thefarmersdog.com/graphql";
const CUSTOMER_GRAPHQL_URL = "https://core-api-customer.k8s.east.thefarmersdog.com/customer-graphql";
const MAX_LOGIN_RETRIES = 3;
const SESSION_FILE = join(process.env.HOME || "/root", ".farmersdog-session.json");

interface SavedSession { wsEndpoint: string; savedAt: number; }

let activeBrowser: Browser | null = null;
let activePage: Page | null = null;
let routeInstalled = false;

function log(msg: string) { console.error(`[farmersdog-mcp] ${msg}`); }

function saveSession(wsEndpoint: string) {
  try { writeFileSync(SESSION_FILE, JSON.stringify({ wsEndpoint, savedAt: Date.now() })); } catch {}
}
function loadSession(): SavedSession | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const d: SavedSession = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    return (Date.now() - d.savedAt < 8 * 3600 * 1000) ? d : null;
  } catch { return null; }
}
function clearSession() {
  try { if (existsSync(SESSION_FILE)) writeFileSync(SESSION_FILE, "{}"); } catch {}
  activePage = null; routeInstalled = false;
  if (activeBrowser) { try { activeBrowser.close(); } catch {} activeBrowser = null; }
}

// ── Request interception ──
// Instead of making our own fetch (which Cloudflare blocks), we hijack
// the app's existing GraphQL requests by swapping the POST body via route.continue().
// The browser's own request carries all cookies/CF clearance, so it passes.

interface PendingQuery {
  targetUrl: string;  // which endpoint to match (graphql or customer-graphql)
  query: string;
  variables: Record<string, unknown>;
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

let pendingQuery: PendingQuery | null = null;

async function handleRoute(route: Route) {
  const url = route.request().url();
  if (pendingQuery && url.includes("core-api-customer")) {
    const pq = pendingQuery;
    pendingQuery = null;
    log(`Intercepting request to ${url.substring(0, 60)}...`);
    pq.resolve(null); // signal that swap happened
    // Swap the body but keep everything else (cookies, headers, CF clearance)
    await route.continue({
      url: pq.targetUrl,
      postData: JSON.stringify({ query: pq.query, variables: pq.variables }),
    });
  } else {
    await route.continue();
  }
}

class FarmersDogClient {
  private email: string;
  private password: string;
  private browserbaseApiKey: string;
  private browserbaseProjectId: string;
  private captchaSolver: Solver | null = null;

  constructor() {
    this.email = process.env.FARMERSDOG_EMAIL || "";
    this.password = process.env.FARMERSDOG_PASSWORD || "";
    this.browserbaseApiKey = process.env.BROWSERBASE_API_KEY || "";
    this.browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID || "";
    const key = process.env.TWOCAPTCHA_API_KEY;
    if (key) { this.captchaSolver = new Solver(key); log("2Captcha solver ready"); }
  }

  private get wsUrl() {
    return `wss://connect.browserbase.com?apiKey=${this.browserbaseApiKey}&projectId=${this.browserbaseProjectId}`;
  }

  private async getPage(): Promise<Page> {
    // 1. In-memory
    if (activePage && routeInstalled) {
      try { await activePage.evaluate(() => true); return activePage; } catch { clearSession(); }
    }
    // 2. Saved session
    const saved = loadSession();
    if (saved) {
      try {
        const browser = await chromium.connectOverCDP(saved.wsEndpoint, { timeout: 15000 });
        const page = browser.contexts()[0]?.pages()[0];
        if (page && page.url().includes("/app/")) {
          await page.evaluate(() => true);
          activeBrowser = browser; activePage = page;
          await this.installRoutes(page);
          log("Reconnected to saved session");
          return page;
        }
        browser.close();
      } catch {} clearSession();
    }
    // 3. Fresh login
    if (!this.email || !this.password || !this.browserbaseApiKey || !this.browserbaseProjectId) {
      throw new Error("Missing creds: FARMERSDOG_EMAIL, FARMERSDOG_PASSWORD, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID");
    }
    for (let i = 1; i <= MAX_LOGIN_RETRIES; i++) {
      log(`Login attempt ${i}/${MAX_LOGIN_RETRIES}...`);
      try {
        const page = await this.login();
        if (page) return page;
      } catch (e) { log(`Attempt ${i}: ${(e as Error).message}`); }
    }
    throw new Error(`Login failed after ${MAX_LOGIN_RETRIES} attempts. Check credentials and 2Captcha balance.`);
  }

  private async installRoutes(page: Page) {
    if (routeInstalled) return;
    await page.route("**/core-api-customer.k8s.east.thefarmersdog.com/**", handleRoute);
    routeInstalled = true;
  }

  private async login(): Promise<Page | null> {
    if (activeBrowser) { try { await activeBrowser.close(); } catch {} }
    const browser = await chromium.connectOverCDP(this.wsUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    activeBrowser = browser; activePage = page;

    await page.goto("https://www.thefarmersdog.com/login", { timeout: 60000 });
    await page.waitForTimeout(5000);

    // Solve Turnstile FIRST — it clears form fields on completion
    const turnstileOk = await this.solveTurnstile(page);
    if (!turnstileOk) return null;

    // Fill BOTH fields AFTER Turnstile
    const formSel = page.getByTestId("loginFormWebsite");
    await formSel.getByRole("textbox", { name: "Email" }).click();
    await page.keyboard.type(this.email, { delay: 30 });
    await formSel.locator("input[type=password]").click();
    await page.keyboard.type(this.password, { delay: 30 });
    await page.waitForTimeout(300);

    // Verify and retry if fields got cleared
    const fields = await page.evaluate(() => {
      const form = document.querySelector("[data-testid=loginFormWebsite]");
      const e = form?.querySelector('input[name="Email"]') as HTMLInputElement;
      const p = form?.querySelector("input[type=password]") as HTMLInputElement;
      return { email: e?.value || "", passLen: p?.value?.length || 0 };
    });
    log(`Fields: email=${fields.email ? "OK" : "EMPTY"} pass=${fields.passLen}chars`);

    if (!fields.email) {
      log("Email cleared, refilling...");
      await formSel.getByRole("textbox", { name: "Email" }).click();
      await page.keyboard.type(this.email, { delay: 20 });
      await page.waitForTimeout(300);
    }
    if (fields.passLen < 5) {
      log("Password cleared, refilling...");
      await formSel.locator("input[type=password]").click();
      await page.keyboard.type(this.password, { delay: 20 });
      await page.waitForTimeout(300);
    }

    // Submit
    await page.evaluate(() => {
      const btns = document.querySelectorAll("button[type=submit]");
      for (const b of btns) { if (!(b as HTMLButtonElement).disabled) { (b as HTMLButtonElement).click(); break; } }
    });

    try {
      await page.waitForURL("**/app/**", { timeout: 25000 });
    } catch {
      log(`Login didn't redirect. URL: ${page.url()}`);
      return null;
    }

    log("Login successful!");
    saveSession(this.wsUrl);
    await this.installRoutes(page);
    return page;
  }

  private async solveTurnstile(page: Page): Promise<boolean> {
    if (this.captchaSolver) {
      try {
        log("Solving Turnstile via 2Captcha...");
        const sitekey = await page.evaluate(() => {
          const w = document.querySelector("[data-sitekey]");
          if (w) return w.getAttribute("data-sitekey");
          const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
          if (iframe) { const m = (iframe.getAttribute("src") || "").match(/[?&]k=([^&]+)/); if (m) return m[1]; }
          return null;
        }) || "0x4AAAAAAAWwgggf84d3DU0J";

        const result = await this.captchaSolver.cloudflareTurnstile({ pageurl: page.url(), sitekey });
        log("2Captcha solved, injecting...");

        await page.evaluate((token: string) => {
          // Inject into all possible Turnstile response fields
          document.querySelectorAll("input[name*='turnstile'], input[name*='cf-'], input[name='cf-turnstile-response']")
            .forEach((el: any) => { el.value = token; });
          // Also try setting via the Turnstile JS API
          const w = (window as any);
          if (w.turnstile) {
            const widgets = document.querySelectorAll(".cf-turnstile");
            widgets.forEach((el: any) => {
              const id = el.getAttribute("data-widget-id") || el.id;
              if (id && w.turnstile.getResponse) try { w.turnstile.getResponse = () => token; } catch {}
            });
          }
          // Dispatch change events
          document.querySelectorAll("form").forEach(f => f.dispatchEvent(new Event("change", { bubbles: true })));
        }, result.data);

        await page.waitForTimeout(2000);

        // Check if button enabled
        const ok = await page.evaluate(() =>
          Array.from(document.querySelectorAll("button[type=submit]")).some(b => !(b as HTMLButtonElement).disabled)
        );
        if (ok) { log("Turnstile solved via 2Captcha"); return true; }
        log("Button still disabled after 2Captcha, falling back to natural...");
      } catch (e) {
        log(`2Captcha error: ${(e as Error).message}, falling back...`);
      }
    }

    // Natural wait
    log("Waiting for Turnstile naturally...");
    for (let i = 0; i < 30; i++) {
      const ok = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button[type=submit]")).some(b => !(b as HTMLButtonElement).disabled)
      );
      if (ok) { log(`Turnstile passed naturally in ${i * 2}s`); return true; }
      await page.waitForTimeout(2000);
    }
    return false;
  }

  /**
   * Execute a GraphQL query by intercepting the app's own request.
   * We navigate to /app/home (which triggers the app's GraphQL calls),
   * intercept one, swap our query body, and capture the response.
   */
  async query<T>(queryStr: string, variables: Record<string, unknown> = {}, retry = true): Promise<T> {
    const page = await this.getPage();
    try {
      return await this.executeInterceptedQuery<T>(page, GRAPHQL_URL, queryStr, variables);
    } catch (e) {
      if (retry && ((e as Error).message?.includes("Target closed") || (e as Error).message?.includes("timeout"))) {
        log("Retrying after session reset...");
        clearSession();
        const newPage = await this.getPage();
        return this.executeInterceptedQuery<T>(newPage, GRAPHQL_URL, queryStr, variables);
      }
      throw e;
    }
  }

  async queryCustomer<T>(queryStr: string, variables: Record<string, unknown> = {}, retry = true): Promise<T> {
    const page = await this.getPage();
    try {
      return await this.executeInterceptedQuery<T>(page, CUSTOMER_GRAPHQL_URL, queryStr, variables);
    } catch (e) {
      if (retry && ((e as Error).message?.includes("Target closed") || (e as Error).message?.includes("timeout"))) {
        log("Retrying after session reset...");
        clearSession();
        const newPage = await this.getPage();
        return this.executeInterceptedQuery<T>(newPage, CUSTOMER_GRAPHQL_URL, queryStr, variables);
      }
      throw e;
    }
  }

  private executeInterceptedQuery<T>(page: Page, targetUrl: string, queryStr: string, variables: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingQuery = null;
        reject(new Error("Query timeout (30s) — app didn't make an interceptable API call."));
      }, 30000);

      let swapped = false;

      // Queue our swap — the route handler will set swapped=true when it fires
      const origResolve = resolve;
      pendingQuery = {
        targetUrl, query: queryStr, variables,
        resolve: () => { swapped = true; },
        reject: () => {}
      };

      // Listen for the response ONLY after our swap happened
      const responseListenerRef = async (r: any) => {
        if (!swapped) return; // ignore responses before our swap
        if (!r.url().includes("core-api-customer")) return;
        try {
          const text = await r.text();
          const json = JSON.parse(text);
          if (json.data) {
            clearTimeout(timeout);
            page.removeListener("response", responseListenerRef);
            origResolve(json.data);
          }
        } catch {}
      };
      page.on("response", responseListenerRef);

      // Trigger the app to make API calls
      page.goto("https://www.thefarmersdog.com/app/home", { waitUntil: "commit" }).catch(() => {});
    });
  }

  async rescheduleViaUI(targetWeek: string, reason = "I'm running low"): Promise<string> {
    const page = await this.getPage();
    await page.goto("https://www.thefarmersdog.com/app/home", { timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.getByText("Reschedule", { exact: true }).first().click();
    await page.waitForTimeout(3000);
    await page.getByText(targetWeek, { exact: true }).first().click();
    await page.waitForTimeout(2000);
    await page.getByText("Continue", { exact: true }).first().click();
    await page.waitForTimeout(3000);
    await page.getByText(reason).first().click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('button[type="submit"]:enabled', { timeout: 10000 });
    await page.getByText("Confirm", { exact: true }).first().click();
    await page.waitForTimeout(5000);
    const body = (await page.textContent("body")) || "";
    const m = body.match(/next delivery will arrive\s*([\w\s—\d]+)/i);
    return m ? `Rescheduled! Next delivery: ${m[1].trim()}` : "Rescheduled successfully";
  }

  // ── Query methods ──
  async getAccount() { return this.query(`query { me { id status activePets: pets(petsInput: {active: true}) { id name } subscriptions { id status type frequency nextDate numberOfBoxes ordersConnection(first: 5) { edges { node { id shipDate states type paymentStatus } } } } referralStats { discountPercentage referralCode } } }`); }
  async getNextDelivery() { return this.query(`query { me { subscriptions { id nextDate frequency status numberOfBoxes } } }`); }
  async getDeliveryHistory(limit = 10) { return this.query(`query { me { subscriptions { ordersConnection(first: ${limit}, shipmentStatuses: [delivered]) { edges { node { id shipDate states type paymentStatus } } } } } }`); }
  async getPets() { return this.query(`query { me { pets { id name } activePets: pets(petsInput: {active: true}) { id name } } }`); }
  async getAvailableDates() { return this.query(`query { configuration { maxDelayDurationInDays } me { id availableNextDates } }`); }
  async getProfile() { return this.queryCustomer(`query { customer { accountInformation { email firstName fullName } canViewDashboard canViewMergedPlanPage } }`); }
  async getOrders() { return this.queryCustomer(`query { customerOrders(futureOrderCount: 2) { current { id petNames pricing { cashTotal pricePerDay pricePerWeek total } scheduling { earliestDesiredArrivalDate latestDesiredArrivalDate isReschedulable rescheduleCutOffDate } shipping { status arrivalDate trackingURL address { addressLine1 addressLine2 city stateAbbreviation zip } } packing { numberOfFoodPacks } } future { id petNames pricing { cashTotal pricePerDay pricePerWeek total } scheduling { earliestDesiredArrivalDate latestDesiredArrivalDate isReschedulable } packing { numberOfFoodPacks } } past { id petNames pricing { cashTotal pricePerDay } shipping { status arrivalDate } packing { numberOfFoodPacks } } } }`); }
  async rescheduleOrder(sid: number, date: string) { return this.query(`mutation RescheduleNextOrder($input: RescheduleNextOrderInput!) { rescheduleNextOrder(input: $input) { success } }`, { input: { subscriptionId: sid, newDate: date } }); }
  async updatePet(pid: number, input: Record<string, unknown>) { return this.query(`mutation EditPetSubmit($petId: Int!, $input: UpdatePetInput!) { updateMyPet(petId: $petId, input: $input) { id pets { id name birthday weight targetWeight activity condition } } }`, { petId: pid, input }); }
  async getPetDetails() { return this.query(`query { me { pets { id name weight size breeds { name } targetWeight gender birthday activity condition neutered suggestedCalories requiredCalories } } }`); }
  async listAvailableRecipes() { return this.query(`query { recipes { name displayName } }`); }
  async getRecipes() { return this.queryCustomer(`query { customer { pets { name foodRecipes { name } plan { id dailyFreshCalories freshFoodRatio } } upcomingTransitionAndRegularOrders { upcomingRegularOrder { avgDaysOfFood dailyPrice } } } }`); }
  async quoteRecipeChange(petId: number, recipes: Array<{ name: string; displayName: string }>) { return this.queryCustomer(`query FetchChangeFreshRecipesQuote($input: ChangeFreshRecipesPlanQuoteInput!) { customer { changeFreshRecipesPlanQuote(input: $input) { dailyConsumptionPrice { original updated } selectedRecipes { displayName name } subscriptionFrequency { original updated } } } }`, { input: { petId, recipes } }); }
  async getOrderSizeQuotes() { return this.queryCustomer(`query { customer { id changeFreshOrderSizeQuotes { current { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice } max { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice } min { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice } } freshSubscription { id nextDate } } }`); }
  async updateOrderSize(size: number) { return this.queryCustomer(`mutation UpdateOrderSize($input: ChangeFreshOrderSizeInput!) { changeFreshOrderSize(input: $input) { customer { id freshSubscription { nextDate } nextOrderToBeDelivered { deliveryWindow { earliestDesiredArrivalDate latestDesiredArrivalDate } } } } }`, { input: { orderSize: size } }); }
  async updateRecipes(planId: number, recipes: Array<{ name: string }>) { return this.queryCustomer(`mutation UpdateFoodPlansRecipes($input: UpdateFoodPlansRecipesInput!) { updateFoodPlansRecipes(input: $input) { customer { freshSubscription { id status lastQuotedPrice { regularOrderTotalConsumptionPrice } } pets { foodRecipes { name } plan { id dailyFreshCalories } } } } }`, { input: { foodPlans: [{ id: planId, selectedRecipes: recipes }], freeFormFeedback: "" } }); }
  async cleanup() { if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; activePage = null; routeInstalled = false; } }
}

function toolHandler(fn: (...args: any[]) => Promise<unknown>) {
  return async (...args: any[]) => {
    try {
      const data = await fn(...args);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
    }
  };
}

async function main() {
  const client = new FarmersDogClient();
  const server = new McpServer({ name: "farmersdog-mcp", version: "2.1.0" });

  server.tool("farmersdog_get_account", "Account overview: pets, subscriptions, orders, referral", {}, toolHandler(() => client.getAccount()));
  server.tool("farmersdog_next_delivery", "Next delivery date + subscription info", {}, toolHandler(() => client.getNextDelivery()));
  server.tool("farmersdog_delivery_history", "Past deliveries", { limit: z.number().optional().default(10) }, toolHandler(({ limit }: any) => client.getDeliveryHistory(limit)));
  server.tool("farmersdog_get_pets", "Registered pets", {}, toolHandler(() => client.getPets()));
  server.tool("farmersdog_get_pet_details", "Detailed pet info: weight, calories, breeds", {}, toolHandler(() => client.getPetDetails()));
  server.tool("farmersdog_available_dates", "Available reschedule dates. Call BEFORE reschedule.", {}, toolHandler(() => client.getAvailableDates()));
  server.tool("farmersdog_get_profile", "Customer profile (name, email)", {}, toolHandler(() => client.getProfile()));
  server.tool("farmersdog_get_orders", "Current + future + past orders with pricing/shipping", {}, toolHandler(() => client.getOrders()));
  server.tool("farmersdog_list_recipes", "All available recipes", {}, toolHandler(() => client.listAvailableRecipes()));
  server.tool("farmersdog_get_recipes", "Current pet recipes + pricing", {}, toolHandler(() => client.getRecipes()));
  server.tool("farmersdog_quote_recipe_change", "Price quote for recipe change", { petId: z.number(), recipes: z.array(z.object({ name: z.string(), displayName: z.string() })) }, toolHandler(({ petId, recipes }: any) => client.quoteRecipeChange(petId, recipes)));
  server.tool("farmersdog_get_order_size_quotes", "Order size options with pricing", {}, toolHandler(() => client.getOrderSizeQuotes()));
  server.tool("farmersdog_reschedule_delivery", "Reschedule via API", { subscriptionId: z.number(), newDate: z.string() }, toolHandler(({ subscriptionId, newDate }: any) => client.rescheduleOrder(subscriptionId, newDate)));
  server.tool("farmersdog_reschedule_delivery_ui", "Reschedule via UI (most reliable)", { targetWeek: z.string(), reason: z.string().optional().default("I'm running low") }, toolHandler(({ targetWeek, reason }: any) => client.rescheduleViaUI(targetWeek, reason)));
  server.tool("farmersdog_update_pet", "Update pet info", { petId: z.number(), birthday: z.string().optional(), weight: z.number().optional(), targetWeight: z.number().optional(), activity: z.number().optional(), condition: z.number().optional() }, toolHandler(({ petId, birthday, weight, targetWeight, activity, condition }: any) => {
    const input: Record<string, unknown> = {};
    if (birthday) { input.birthday = birthday; input.birthdayAccuracy = "date"; }
    if (weight !== undefined) input.weight = weight;
    if (targetWeight !== undefined) input.targetWeight = targetWeight;
    if (activity !== undefined) input.activity = activity;
    if (condition !== undefined) input.condition = condition;
    return client.updatePet(petId, input);
  }));
  server.tool("farmersdog_update_recipes", "Change recipes. Call quote first.", { planId: z.number(), recipes: z.array(z.object({ name: z.string() })) }, toolHandler(({ planId, recipes }: any) => client.updateRecipes(planId, recipes)));
  server.tool("farmersdog_update_order_size", "Change order size (28=4wk, 56=8wk)", { orderSize: z.number() }, toolHandler(({ orderSize }: any) => client.updateOrderSize(orderSize)));

  process.on("SIGINT", async () => { await client.cleanup(); process.exit(0); });
  process.on("SIGTERM", async () => { await client.cleanup(); process.exit(0); });
  await server.connect(new StdioServerTransport());
}

main().catch(console.error);
