#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, Browser, Page } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const BASE_URL = "https://core-api-customer.k8s.east.thefarmersdog.com";
const GRAPHQL_URL = `${BASE_URL}/graphql`;
const CUSTOMER_GRAPHQL_URL = `${BASE_URL}/customer-graphql`;

const MAX_LOGIN_RETRIES = 3;
const TURNSTILE_POLL_INTERVAL_MS = 2000;
const TURNSTILE_TIMEOUT_MS = 60000;
const SESSION_FILE = join(process.env.HOME || "/root", ".farmersdog-session.json");

interface TokenData {
  token: string;
  expiresAt: number;
}

interface SavedSession {
  wsEndpoint: string;
  token: string;
  tokenExpiresAt: number;
  savedAt: number;
}

let cachedToken: TokenData | null = null;
let activeBrowser: Browser | null = null;
let activePage: Page | null = null;

function log(msg: string) {
  console.error(`[farmersdog-mcp] ${msg}`);
}

function saveSession(wsEndpoint: string, token: string, expiresAt: number) {
  try {
    const data: SavedSession = { wsEndpoint, token, tokenExpiresAt: expiresAt, savedAt: Date.now() };
    writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
    log("Session saved to disk");
  } catch (e) {
    log(`Failed to save session: ${(e as Error).message}`);
  }
}

function loadSession(): SavedSession | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const data: SavedSession = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    // Session older than 12h is stale
    if (Date.now() - data.savedAt > 12 * 3600 * 1000) {
      log("Saved session too old, ignoring");
      return null;
    }
    if (data.tokenExpiresAt < Date.now() + 60000) {
      log("Saved token expired, ignoring");
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function clearSavedSession() {
  try {
    if (existsSync(SESSION_FILE)) {
      writeFileSync(SESSION_FILE, "{}");
    }
  } catch {}
  cachedToken = null;
  activePage = null;
  if (activeBrowser) {
    try { activeBrowser.close(); } catch {}
    activeBrowser = null;
  }
}

class FarmersDogClient {
  private email?: string;
  private password?: string;
  private browserbaseApiKey?: string;
  private browserbaseProjectId?: string;

  constructor() {
    this.email = process.env.FARMERSDOG_EMAIL;
    this.password = process.env.FARMERSDOG_PASSWORD;
    this.browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
    this.browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
  }

  private get wsUrl(): string {
    return `wss://connect.browserbase.com?apiKey=${this.browserbaseApiKey}&projectId=${this.browserbaseProjectId}`;
  }

  /**
   * Ensure we have an authenticated browser page.
   */
  private async getAuthenticatedPage(): Promise<{ token: string; page: Page }> {
    // 1. Try existing in-memory session
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000 && activePage) {
      try {
        await activePage.evaluate(() => true);
        return { token: cachedToken.token, page: activePage };
      } catch {
        log("In-memory page dead, clearing");
        clearSavedSession();
      }
    }

    // 2. Try reconnecting to saved session
    const saved = loadSession();
    if (saved) {
      log("Attempting to reconnect to saved Browserbase session...");
      try {
        const browser = await chromium.connectOverCDP(saved.wsEndpoint, { timeout: 15000 });
        const context = browser.contexts()[0];
        const page = context?.pages()[0];
        if (page) {
          await page.evaluate(() => true); // verify alive
          activeBrowser = browser;
          activePage = page;
          cachedToken = { token: saved.token, expiresAt: saved.tokenExpiresAt };
          log("Reconnected to saved session!");
          return { token: saved.token, page };
        }
        browser.close();
      } catch (e) {
        log(`Reconnect failed: ${(e as Error).message}`);
        clearSavedSession();
      }
    }

    // 3. Try manual token from env
    const manualToken = process.env.FARMERSDOG_TOKEN;
    if (manualToken) {
      try {
        const payload = JSON.parse(Buffer.from(manualToken.split(".")[1], "base64").toString());
        if (payload.exp * 1000 > Date.now() + 60000) {
          cachedToken = { token: manualToken, expiresAt: payload.exp * 1000 };
          const { page } = await this.createBrowserSession();
          await page.goto("https://www.thefarmersdog.com", { timeout: 30000 });
          await page.waitForTimeout(3000);
          return { token: manualToken, page };
        }
      } catch {}
    }

    // 4. Login via Browserbase with retries
    if (!this.email || !this.password || !this.browserbaseApiKey || !this.browserbaseProjectId) {
      throw new Error(
        "Missing credentials. Set FARMERSDOG_EMAIL, FARMERSDOG_PASSWORD, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID"
      );
    }

    for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
      log(`Login attempt ${attempt}/${MAX_LOGIN_RETRIES}...`);
      try {
        const result = await this.loginWithBrowserBase();
        if (result) return result;
      } catch (error) {
        log(`Attempt ${attempt} failed: ${(error as Error).message}`);
        if (attempt === MAX_LOGIN_RETRIES) {
          throw new Error(
            `Login failed after ${MAX_LOGIN_RETRIES} attempts. Cloudflare Turnstile may be blocking. ` +
            `Try again in a few minutes, or manually log in at thefarmersdog.com and set FARMERSDOG_TOKEN.`
          );
        }
      }
    }

    throw new Error("Login failed unexpectedly");
  }

  private async createBrowserSession(): Promise<{ browser: Browser; page: Page }> {
    if (activeBrowser) {
      try { await activeBrowser.close(); } catch {}
    }

    const browser = await chromium.connectOverCDP(this.wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    activeBrowser = browser;
    activePage = page;

    return { browser, page };
  }

  private async loginWithBrowserBase(): Promise<{ token: string; page: Page } | null> {
    log("Logging in via Browserbase...");

    const { page } = await this.createBrowserSession();

    await page.goto("https://www.thefarmersdog.com/login", { timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.fill('input[type="email"]', this.email!);
    await page.fill('input[type="password"]', this.password!);

    // Smart Turnstile polling: wait for submit button to become enabled
    log("Waiting for Turnstile to pass...");
    const pollStart = Date.now();
    let buttonEnabled = false;
    while (Date.now() - pollStart < TURNSTILE_TIMEOUT_MS) {
      try {
        const enabled = await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
          return btn ? !btn.disabled : false;
        });
        if (enabled) {
          buttonEnabled = true;
          log(`Turnstile passed in ${Math.round((Date.now() - pollStart) / 1000)}s`);
          break;
        }
      } catch {}
      await page.waitForTimeout(TURNSTILE_POLL_INTERVAL_MS);
    }

    if (!buttonEnabled) {
      log("Turnstile timeout — submit button never enabled");
      return null;
    }

    // Capture the login response token
    let token: string | null = null;
    page.on("response", async (response) => {
      if (response.url().includes("core-api")) {
        try {
          const data = await response.json();
          if (data?.data?.loginCustomer?.token) {
            token = data.data.loginCustomer.token;
          }
        } catch {}
      }
    });

    // Click submit
    try {
      const btn = await page.waitForSelector('button[type="submit"]:enabled', { timeout: 5000 });
      await btn.click();
      log("Clicked login button");
    } catch {
      log("Submit button not found/enabled after Turnstile poll");
      return null;
    }

    // Wait for navigation
    await page.waitForTimeout(10000);

    if (!page.url().includes("/app/")) {
      log(`Login failed, URL: ${page.url()}`);
      return null;
    }

    // Save clean fetch before analytics patches it
    await page.context().addInitScript(() => {
      (window as any).__cleanFetch = window.fetch.bind(window);
    });

    await page.goto("https://www.thefarmersdog.com/app/home", { timeout: 30000 });
    await page.waitForTimeout(3000);

    // Extract token from page if not captured via response
    if (!token) {
      try {
        token = await page.evaluate(() => {
          for (const storage of [localStorage, sessionStorage]) {
            for (let i = 0; i < storage.length; i++) {
              const key = storage.key(i)!;
              const val = storage.getItem(key) || "";
              if (val.startsWith("eyJ") && val.split(".").length === 3) return val;
            }
          }
          return null;
        });
      } catch {}
    }

    if (!token) {
      // Try cookie-based auth
      try {
        const testResult = await page.evaluate(async (url) => {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: "{ me { id } }" }),
            credentials: "include",
          });
          return await r.json();
        }, GRAPHQL_URL);

        if (testResult?.data?.me?.id) {
          log("Authenticated via cookies (no Bearer token needed)");
          cachedToken = { token: "__cookie_auth__", expiresAt: Date.now() + 3600000 };
          saveSession(this.wsUrl, "__cookie_auth__", cachedToken.expiresAt);
          return { token: "__cookie_auth__", page };
        }
      } catch {}

      log("Login failed — no auth method worked");
      return null;
    }

    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    cachedToken = { token, expiresAt: payload.exp * 1000 };
    saveSession(this.wsUrl, token, cachedToken.expiresAt);
    log("Login successful!");

    return { token, page };
  }

  /**
   * Execute a GraphQL query via the browser's fetch (bypasses Cloudflare).
   * Auto-reconnects once if the session dies mid-operation.
   */
  async query<T>(queryStr: string, variables: Record<string, unknown> = {}, retry = true): Promise<T> {
    const { token, page } = await this.getAuthenticatedPage();

    try {
      const result = await page.evaluate(
        async ({ url, query, variables, token }) => {
          const fetchFn = (window as any).__cleanFetch || window.fetch;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (token && token !== "__cookie_auth__") headers["Authorization"] = `Bearer ${token}`;
          try {
            const r = await fetchFn(url, {
              method: "POST",
              headers,
              body: JSON.stringify({ query, variables }),
              credentials: "include",
            });
            const text = await r.text();
            try { return JSON.parse(text); }
            catch { return { error: `Non-JSON response (${r.status}): ${text.substring(0, 200)}` }; }
          } catch (e: any) {
            return { error: `Fetch error: ${e.message}` };
          }
        },
        { url: GRAPHQL_URL, query: queryStr, variables, token }
      );

      if (result.error) throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
      if (result.errors) throw new Error(result.errors[0]?.message || "GraphQL error");
      return result.data;
    } catch (e) {
      // Auto-reconnect on session death
      if (retry && (e as Error).message?.includes("Target closed") || (e as Error).message?.includes("Session closed")) {
        log("Session died mid-query, reconnecting...");
        clearSavedSession();
        return this.query<T>(queryStr, variables, false);
      }
      throw e;
    }
  }

  async queryCustomer<T>(queryStr: string, variables: Record<string, unknown> = {}, retry = true): Promise<T> {
    const { token, page } = await this.getAuthenticatedPage();

    try {
      const result = await page.evaluate(
        async ({ url, query, variables, token }) => {
          const fetchFn = (window as any).__cleanFetch || window.fetch;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (token && token !== "__cookie_auth__") headers["Authorization"] = `Bearer ${token}`;
          try {
            const r = await fetchFn(url, {
              method: "POST",
              headers,
              body: JSON.stringify({ query, variables }),
              credentials: "include",
            });
            const text = await r.text();
            try { return JSON.parse(text); }
            catch { return { error: `Non-JSON response (${r.status}): ${text.substring(0, 200)}` }; }
          } catch (e: any) {
            return { error: `Fetch error: ${e.message}` };
          }
        },
        { url: CUSTOMER_GRAPHQL_URL, query: queryStr, variables, token }
      );

      if (result.error) throw new Error(result.error);
      if (result.errors) throw new Error(result.errors[0]?.message || "GraphQL error");
      return result.data;
    } catch (e) {
      if (retry && ((e as Error).message?.includes("Target closed") || (e as Error).message?.includes("Session closed"))) {
        log("Session died mid-query, reconnecting...");
        clearSavedSession();
        return this.queryCustomer<T>(queryStr, variables, false);
      }
      throw e;
    }
  }

  async rescheduleViaUI(targetWeek: string, reason: string = "I'm running low"): Promise<string> {
    const { page } = await this.getAuthenticatedPage();

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
    const match = body.match(/next delivery will arrive\s*([\w\s—\d]+)/i);
    return match ? `Rescheduled! Next delivery: ${match[1].trim()}` : "Rescheduled successfully";
  }

  // ── Query methods ──

  async getAccount(): Promise<unknown> {
    return this.query(`
      query CustomerAccount {
        me {
          id
          status
          activePets: pets(petsInput: {active: true}) { id name }
          subscriptions {
            id status type frequency nextDate numberOfBoxes
            ordersConnection(first: 5) {
              edges { node { id shipDate states type paymentStatus } }
            }
          }
          referralStats { discountPercentage referralCode }
        }
      }
    `);
  }

  async getNextDelivery(): Promise<unknown> {
    return this.query(`query { me { subscriptions { id nextDate frequency status numberOfBoxes } } }`);
  }

  async getDeliveryHistory(limit: number = 10): Promise<unknown> {
    return this.query(`
      query { me { subscriptions {
        ordersConnection(first: ${limit}, shipmentStatuses: [delivered]) {
          edges { node { id shipDate states type paymentStatus } }
        }
      } } }
    `);
  }

  async getPets(): Promise<unknown> {
    return this.query(`query { me { pets { id name } activePets: pets(petsInput: {active: true}) { id name } } }`);
  }

  async getAvailableDates(): Promise<unknown> {
    return this.query(`
      query FetchAvailableNextDatesSubscription {
        configuration { maxDelayDurationInDays }
        me { id availableNextDates }
      }
    `);
  }

  async getProfile(): Promise<unknown> {
    return this.queryCustomer(`
      query CustomerAccount {
        customer {
          accountInformation { email firstName fullName }
          canViewDashboard canViewMergedPlanPage
        }
      }
    `);
  }

  async getOrders(): Promise<unknown> {
    return this.queryCustomer(`
      query {
        customerOrders(futureOrderCount: 2) {
          current {
            id petNames
            pricing { cashTotal pricePerDay pricePerWeek total }
            scheduling { earliestDesiredArrivalDate latestDesiredArrivalDate isReschedulable rescheduleCutOffDate }
            shipping { status arrivalDate trackingURL address { addressLine1 addressLine2 city stateAbbreviation zip } }
            packing { numberOfFoodPacks }
          }
          future {
            id petNames
            pricing { cashTotal pricePerDay pricePerWeek total }
            scheduling { earliestDesiredArrivalDate latestDesiredArrivalDate isReschedulable }
            packing { numberOfFoodPacks }
          }
          past {
            id petNames
            pricing { cashTotal pricePerDay }
            shipping { status arrivalDate }
            packing { numberOfFoodPacks }
          }
        }
      }
    `);
  }

  async rescheduleOrder(subscriptionId: number, newDate: string): Promise<unknown> {
    return this.query(
      `mutation RescheduleNextOrder($input: RescheduleNextOrderInput!) {
        rescheduleNextOrder(input: $input) { success }
      }`,
      { input: { subscriptionId, newDate } }
    );
  }

  async updatePet(petId: number, input: Record<string, unknown>): Promise<unknown> {
    return this.query(
      `mutation EditPetSubmit($petId: Int!, $input: UpdatePetInput!) {
        updateMyPet(petId: $petId, input: $input) {
          id pets { id name birthday weight targetWeight activity condition }
        }
      }`,
      { petId, input }
    );
  }

  async getPetDetails(): Promise<unknown> {
    return this.query(`
      query { me { pets {
        id name weight size breeds { name } targetWeight gender birthday
        activity condition neutered suggestedCalories requiredCalories
      } } }
    `);
  }

  async listAvailableRecipes(): Promise<unknown> {
    return this.query(`query { recipes { name displayName } }`);
  }

  async getRecipes(): Promise<unknown> {
    return this.queryCustomer(`
      query {
        customer {
          pets { name foodRecipes { name } plan { id dailyFreshCalories freshFoodRatio } }
          upcomingTransitionAndRegularOrders {
            upcomingRegularOrder { avgDaysOfFood dailyPrice }
          }
        }
      }
    `);
  }

  async quoteRecipeChange(petId: number, recipes: Array<{ name: string; displayName: string }>): Promise<unknown> {
    return this.queryCustomer(
      `query FetchChangeFreshRecipesQuote($input: ChangeFreshRecipesPlanQuoteInput!) {
        customer { changeFreshRecipesPlanQuote(input: $input) {
          dailyConsumptionPrice { original updated }
          selectedRecipes { displayName name }
          subscriptionFrequency { original updated }
        } }
      }`,
      { input: { petId, recipes } }
    );
  }

  async getOrderSizeQuotes(): Promise<unknown> {
    return this.queryCustomer(`
      query GetChangeOrderSizeQuotes {
        customer {
          id
          changeFreshOrderSizeQuotes {
            current { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice }
            max { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice }
            min { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice }
          }
          freshSubscription { id nextDate }
        }
      }
    `);
  }

  async updateOrderSize(orderSize: number): Promise<unknown> {
    return this.queryCustomer(
      `mutation UpdateOrderSize($input: ChangeFreshOrderSizeInput!) {
        changeFreshOrderSize(input: $input) {
          customer {
            id freshSubscription { nextDate }
            nextOrderToBeDelivered { deliveryWindow { earliestDesiredArrivalDate latestDesiredArrivalDate } }
          }
        }
      }`,
      { input: { orderSize } }
    );
  }

  async updateRecipes(planId: number, recipes: Array<{ name: string }>): Promise<unknown> {
    return this.queryCustomer(
      `mutation UpdateFoodPlansRecipes($input: UpdateFoodPlansRecipesInput!) {
        updateFoodPlansRecipes(input: $input) {
          customer {
            freshSubscription { id status lastQuotedPrice { regularOrderTotalConsumptionPrice } }
            pets { foodRecipes { name } plan { id dailyFreshCalories } }
          }
        }
      }`,
      { input: { foodPlans: [{ id: planId, selectedRecipes: recipes }], freeFormFeedback: "" } }
    );
  }

  async cleanup(): Promise<void> {
    if (activeBrowser) {
      try { await activeBrowser.close(); } catch {}
      activeBrowser = null;
      activePage = null;
    }
  }
}

// ── Helper to wrap tool handlers with consistent error formatting ──
function toolHandler(fn: (...args: any[]) => Promise<unknown>) {
  return async (...args: any[]) => {
    try {
      const data = await fn(...args);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}. Try again — if auth fails repeatedly, set FARMERSDOG_TOKEN manually.` }],
        isError: true,
      };
    }
  };
}

async function main() {
  const client = new FarmersDogClient();

  const server = new McpServer({
    name: "farmersdog-mcp",
    version: "2.0.0",
  });

  // ── Read-only tools ──

  server.tool(
    "farmersdog_get_account",
    "Get Farmer's Dog account overview: pets, subscriptions, recent orders, referral code",
    {},
    toolHandler(() => client.getAccount()),
  );

  server.tool(
    "farmersdog_next_delivery",
    "Get next scheduled delivery date and subscription details",
    {},
    toolHandler(() => client.getNextDelivery()),
  );

  server.tool(
    "farmersdog_delivery_history",
    "Get past delivery history (shipped orders)",
    { limit: z.number().optional().default(10).describe("Number of past deliveries to retrieve") },
    toolHandler(({ limit }: { limit: number }) => client.getDeliveryHistory(limit)),
  );

  server.tool(
    "farmersdog_get_pets",
    "Get registered pets (active and inactive)",
    {},
    toolHandler(() => client.getPets()),
  );

  server.tool(
    "farmersdog_get_pet_details",
    "Get detailed pet info: weight, activity, calories, breeds",
    {},
    toolHandler(() => client.getPetDetails()),
  );

  server.tool(
    "farmersdog_available_dates",
    "Get available dates for rescheduling next delivery. Call this BEFORE reschedule_delivery.",
    {},
    toolHandler(() => client.getAvailableDates()),
  );

  server.tool(
    "farmersdog_get_profile",
    "Get customer profile (name, email)",
    {},
    toolHandler(() => client.getProfile()),
  );

  server.tool(
    "farmersdog_get_orders",
    "Get current + future + past orders with pricing, shipping, and delivery details",
    {},
    toolHandler(() => client.getOrders()),
  );

  server.tool(
    "farmersdog_list_recipes",
    "List all available Farmer's Dog recipes (TURKEY, BEEF, CHICKEN, PORK, CHICKEN_OATS_COLLARDS)",
    {},
    toolHandler(() => client.listAvailableRecipes()),
  );

  server.tool(
    "farmersdog_get_recipes",
    "Get current recipes for your pets with pricing. Use plan.id for update_recipes.",
    {},
    toolHandler(() => client.getRecipes()),
  );

  server.tool(
    "farmersdog_quote_recipe_change",
    "Get price quote for changing recipes BEFORE confirming. Shows price diff and new frequency.",
    {
      petId: z.number().describe("Pet ID (get from farmersdog_get_pets)"),
      recipes: z.array(z.object({
        name: z.string().describe("Recipe code: TURKEY, BEEF, CHICKEN, PORK, or CHICKEN_OATS_COLLARDS"),
        displayName: z.string().describe("Display name: Turkey, Beef, Chicken, Pork, or Chicken & Grain"),
      })).describe("1-3 recipes to quote"),
    },
    toolHandler(({ petId, recipes }: { petId: number; recipes: Array<{ name: string; displayName: string }> }) =>
      client.quoteRecipeChange(petId, recipes)
    ),
  );

  server.tool(
    "farmersdog_get_order_size_quotes",
    "Get available order sizes with pricing comparison (current vs min vs max)",
    {},
    toolHandler(() => client.getOrderSizeQuotes()),
  );

  // ── Mutating tools ──

  server.tool(
    "farmersdog_reschedule_delivery",
    "Reschedule next delivery via API. Call farmersdog_available_dates first to get valid dates.",
    {
      subscriptionId: z.number().describe("Subscription ID (from farmersdog_get_account)"),
      newDate: z.string().describe("New date YYYY-MM-DD (must be from farmersdog_available_dates)"),
    },
    toolHandler(({ subscriptionId, newDate }: { subscriptionId: number; newDate: string }) =>
      client.rescheduleOrder(subscriptionId, newDate)
    ),
  );

  server.tool(
    "farmersdog_reschedule_delivery_ui",
    "Reschedule via website UI (more reliable, handles Cloudflare). Pass week label exactly as shown.",
    {
      targetWeek: z.string().describe("Week label e.g. 'Week of March 1'"),
      reason: z.string().optional().default("I'm running low").describe("Reason for rescheduling"),
    },
    toolHandler(({ targetWeek, reason }: { targetWeek: string; reason: string }) =>
      client.rescheduleViaUI(targetWeek, reason)
    ),
  );

  server.tool(
    "farmersdog_update_pet",
    "Update pet info (birthday, weight, activity, condition)",
    {
      petId: z.number().describe("Pet ID (from farmersdog_get_pets)"),
      birthday: z.string().optional().describe("Birthday YYYY-MM-DD"),
      weight: z.number().optional().describe("Weight in grams"),
      targetWeight: z.number().optional().describe("Target weight in grams"),
      activity: z.number().optional().describe("Activity level 1-5"),
      condition: z.number().optional().describe("Body condition 1-9"),
    },
    toolHandler(({ petId, birthday, weight, targetWeight, activity, condition }: any) => {
      const input: Record<string, unknown> = {};
      if (birthday) { input.birthday = birthday; input.birthdayAccuracy = "date"; }
      if (weight !== undefined) input.weight = weight;
      if (targetWeight !== undefined) input.targetWeight = targetWeight;
      if (activity !== undefined) input.activity = activity;
      if (condition !== undefined) input.condition = condition;
      return client.updatePet(petId, input);
    }),
  );

  server.tool(
    "farmersdog_update_recipes",
    "Confirm recipe changes. Call farmersdog_quote_recipe_change first to see pricing impact.",
    {
      planId: z.number().describe("Plan ID (from farmersdog_get_recipes -> plan.id)"),
      recipes: z.array(z.object({
        name: z.string().describe("Recipe code: TURKEY, BEEF, CHICKEN, PORK, or CHICKEN_OATS_COLLARDS"),
      })).describe("1-3 recipes to set"),
    },
    toolHandler(({ planId, recipes }: { planId: number; recipes: Array<{ name: string }> }) =>
      client.updateRecipes(planId, recipes)
    ),
  );

  server.tool(
    "farmersdog_update_order_size",
    "Change order size/frequency. 28 = 4 weeks, 56 = 8 weeks. Larger = cheaper per day.",
    {
      orderSize: z.number().describe("Order size in days (28 or 56)"),
    },
    toolHandler(({ orderSize }: { orderSize: number }) => client.updateOrderSize(orderSize)),
  );

  // Cleanup on exit
  process.on("SIGINT", async () => { await client.cleanup(); process.exit(0); });
  process.on("SIGTERM", async () => { await client.cleanup(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
