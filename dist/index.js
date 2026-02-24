#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { Solver } from "@2captcha/captcha-solver";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
const GRAPHQL_URL = "https://core-api-customer.k8s.east.thefarmersdog.com/graphql";
const CUSTOMER_GRAPHQL_URL = "https://core-api-customer.k8s.east.thefarmersdog.com/customer-graphql";
const MAX_LOGIN_RETRIES = 3;
const SESSION_FILE = join(process.env.HOME || "/root", ".farmersdog-session.json");
let activeBrowser = null;
let activePage = null;
let routeInstalled = false;
function log(msg) { console.error(`[farmersdog-mcp] ${msg}`); }
function saveSession(wsEndpoint) {
    try {
        writeFileSync(SESSION_FILE, JSON.stringify({ wsEndpoint, savedAt: Date.now() }));
    }
    catch { }
}
function loadSession() {
    try {
        if (!existsSync(SESSION_FILE))
            return null;
        const d = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
        return (Date.now() - d.savedAt < 8 * 3600 * 1000) ? d : null;
    }
    catch {
        return null;
    }
}
function clearSession() {
    try {
        if (existsSync(SESSION_FILE))
            writeFileSync(SESSION_FILE, "{}");
    }
    catch { }
    activePage = null;
    routeInstalled = false;
    if (activeBrowser) {
        try {
            activeBrowser.close();
        }
        catch { }
        activeBrowser = null;
    }
}
let pendingQuery = null;
async function handleRoute(route) {
    const url = route.request().url();
    if (pendingQuery && url.includes("core-api-customer")) {
        const pq = pendingQuery;
        pendingQuery = null;
        log(`Intercepting request to ${url.substring(0, 60)}...`);
        // Swap the body but keep everything else (cookies, headers, CF clearance)
        await route.continue({
            url: pq.targetUrl,
            postData: JSON.stringify({ query: pq.query, variables: pq.variables }),
        });
    }
    else {
        await route.continue();
    }
}
class FarmersDogClient {
    email;
    password;
    browserbaseApiKey;
    browserbaseProjectId;
    captchaSolver = null;
    constructor() {
        this.email = process.env.FARMERSDOG_EMAIL || "";
        this.password = process.env.FARMERSDOG_PASSWORD || "";
        this.browserbaseApiKey = process.env.BROWSERBASE_API_KEY || "";
        this.browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID || "";
        const key = process.env.TWOCAPTCHA_API_KEY;
        if (key) {
            this.captchaSolver = new Solver(key);
            log("2Captcha solver ready");
        }
    }
    get wsUrl() {
        return `wss://connect.browserbase.com?apiKey=${this.browserbaseApiKey}&projectId=${this.browserbaseProjectId}`;
    }
    async getPage() {
        // 1. In-memory
        if (activePage && routeInstalled) {
            try {
                await activePage.evaluate(() => true);
                return activePage;
            }
            catch {
                clearSession();
            }
        }
        // 2. Saved session
        const saved = loadSession();
        if (saved) {
            try {
                const browser = await chromium.connectOverCDP(saved.wsEndpoint, { timeout: 15000 });
                const page = browser.contexts()[0]?.pages()[0];
                if (page && page.url().includes("/app/")) {
                    await page.evaluate(() => true);
                    activeBrowser = browser;
                    activePage = page;
                    await this.installRoutes(page);
                    log("Reconnected to saved session");
                    return page;
                }
                browser.close();
            }
            catch { }
            clearSession();
        }
        // 3. Fresh login
        if (!this.email || !this.password || !this.browserbaseApiKey || !this.browserbaseProjectId) {
            throw new Error("Missing creds: FARMERSDOG_EMAIL, FARMERSDOG_PASSWORD, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID");
        }
        for (let i = 1; i <= MAX_LOGIN_RETRIES; i++) {
            log(`Login attempt ${i}/${MAX_LOGIN_RETRIES}...`);
            try {
                const page = await this.login();
                if (page)
                    return page;
            }
            catch (e) {
                log(`Attempt ${i}: ${e.message}`);
            }
        }
        throw new Error(`Login failed after ${MAX_LOGIN_RETRIES} attempts. Check credentials and 2Captcha balance.`);
    }
    async installRoutes(page) {
        if (routeInstalled)
            return;
        await page.route("**/core-api-customer.k8s.east.thefarmersdog.com/**", handleRoute);
        routeInstalled = true;
    }
    async login() {
        if (activeBrowser) {
            try {
                await activeBrowser.close();
            }
            catch { }
        }
        const browser = await chromium.connectOverCDP(this.wsUrl);
        const ctx = browser.contexts()[0];
        const page = ctx.pages()[0] || await ctx.newPage();
        activeBrowser = browser;
        activePage = page;
        await page.goto("https://www.thefarmersdog.com/login", { timeout: 60000 });
        await page.waitForTimeout(5000);
        // Fill password first (survives Turnstile re-renders)
        const formSel = page.getByTestId("loginFormWebsite");
        await formSel.locator("input[type=password]").click();
        await page.keyboard.type(this.password, { delay: 40 });
        // Wait for Turnstile (natural or 2Captcha)
        const turnstileOk = await this.solveTurnstile(page);
        if (!turnstileOk)
            return null;
        // Fill email AFTER Turnstile (it clears the email field on completion)
        await formSel.getByRole("textbox", { name: "Email" }).click();
        await page.keyboard.type(this.email, { delay: 30 });
        await page.waitForTimeout(300);
        // Verify fields
        const fields = await page.evaluate(() => {
            const form = document.querySelector("[data-testid=loginFormWebsite]") || document;
            const e = form.querySelector("input[type=email]");
            const p = form.querySelector("input[type=password]");
            return { email: e?.value || "", passLen: p?.value?.length || 0 };
        });
        log(`Fields: email=${fields.email ? "OK" : "EMPTY"} pass=${fields.passLen}chars`);
        if (!fields.email || fields.passLen < 5)
            return null;
        // Submit
        await page.evaluate(() => {
            const btns = document.querySelectorAll("button[type=submit]");
            for (const b of btns) {
                if (!b.disabled) {
                    b.click();
                    break;
                }
            }
        });
        try {
            await page.waitForURL("**/app/**", { timeout: 25000 });
        }
        catch {
            log(`Login didn't redirect. URL: ${page.url()}`);
            return null;
        }
        log("Login successful!");
        saveSession(this.wsUrl);
        await this.installRoutes(page);
        return page;
    }
    async solveTurnstile(page) {
        if (this.captchaSolver) {
            try {
                log("Solving Turnstile via 2Captcha...");
                const sitekey = await page.evaluate(() => {
                    const w = document.querySelector("[data-sitekey]");
                    if (w)
                        return w.getAttribute("data-sitekey");
                    const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                    if (iframe) {
                        const m = (iframe.getAttribute("src") || "").match(/[?&]k=([^&]+)/);
                        if (m)
                            return m[1];
                    }
                    return null;
                }) || "0x4AAAAAAA1dwgJRIjCpfp_v";
                const result = await this.captchaSolver.cloudflareTurnstile({ pageurl: page.url(), sitekey });
                log("2Captcha solved, injecting...");
                await page.evaluate((token) => {
                    // Inject into all possible Turnstile response fields
                    document.querySelectorAll("input[name*='turnstile'], input[name*='cf-'], input[name='cf-turnstile-response']")
                        .forEach((el) => { el.value = token; });
                    // Also try setting via the Turnstile JS API
                    const w = window;
                    if (w.turnstile) {
                        const widgets = document.querySelectorAll(".cf-turnstile");
                        widgets.forEach((el) => {
                            const id = el.getAttribute("data-widget-id") || el.id;
                            if (id && w.turnstile.getResponse)
                                try {
                                    w.turnstile.getResponse = () => token;
                                }
                                catch { }
                        });
                    }
                    // Dispatch change events
                    document.querySelectorAll("form").forEach(f => f.dispatchEvent(new Event("change", { bubbles: true })));
                }, result.data);
                await page.waitForTimeout(2000);
                // Check if button enabled
                const ok = await page.evaluate(() => Array.from(document.querySelectorAll("button[type=submit]")).some(b => !b.disabled));
                if (ok) {
                    log("Turnstile solved via 2Captcha");
                    return true;
                }
                log("Button still disabled after 2Captcha, falling back to natural...");
            }
            catch (e) {
                log(`2Captcha error: ${e.message}, falling back...`);
            }
        }
        // Natural wait
        log("Waiting for Turnstile naturally...");
        for (let i = 0; i < 30; i++) {
            const ok = await page.evaluate(() => Array.from(document.querySelectorAll("button[type=submit]")).some(b => !b.disabled));
            if (ok) {
                log(`Turnstile passed naturally in ${i * 2}s`);
                return true;
            }
            await page.waitForTimeout(2000);
        }
        return false;
    }
    /**
     * Execute a GraphQL query by intercepting the app's own request.
     * We navigate to /app/home (which triggers the app's GraphQL calls),
     * intercept one, swap our query body, and capture the response.
     */
    async query(queryStr, variables = {}, retry = true) {
        const page = await this.getPage();
        try {
            return await this.executeInterceptedQuery(page, GRAPHQL_URL, queryStr, variables);
        }
        catch (e) {
            if (retry && (e.message?.includes("Target closed") || e.message?.includes("timeout"))) {
                log("Retrying after session reset...");
                clearSession();
                const newPage = await this.getPage();
                return this.executeInterceptedQuery(newPage, GRAPHQL_URL, queryStr, variables);
            }
            throw e;
        }
    }
    async queryCustomer(queryStr, variables = {}, retry = true) {
        const page = await this.getPage();
        try {
            return await this.executeInterceptedQuery(page, CUSTOMER_GRAPHQL_URL, queryStr, variables);
        }
        catch (e) {
            if (retry && (e.message?.includes("Target closed") || e.message?.includes("timeout"))) {
                log("Retrying after session reset...");
                clearSession();
                const newPage = await this.getPage();
                return this.executeInterceptedQuery(newPage, CUSTOMER_GRAPHQL_URL, queryStr, variables);
            }
            throw e;
        }
    }
    executeInterceptedQuery(page, targetUrl, queryStr, variables) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingQuery = null;
                responseHandler = null;
                reject(new Error("Query timeout (30s) — app didn't make an interceptable API call."));
            }, 30000);
            // Listen for the response to our swapped request
            let responseHandler = async (r) => {
                if (!r.url().includes("core-api-customer"))
                    return;
                try {
                    const text = await r.text();
                    const json = JSON.parse(text);
                    if (json.data) {
                        clearTimeout(timeout);
                        responseHandler = null;
                        page.removeListener("response", responseListenerRef);
                        resolve(json.data);
                    }
                }
                catch { }
            };
            const responseListenerRef = (r) => { if (responseHandler)
                responseHandler(r); };
            page.on("response", responseListenerRef);
            // Queue our swap
            pendingQuery = { targetUrl, query: queryStr, variables, resolve: () => { }, reject: () => { } };
            // Trigger the app to make API calls
            page.goto("https://www.thefarmersdog.com/app/home", { waitUntil: "commit" }).catch(() => { });
        });
    }
    async rescheduleViaUI(targetWeek, reason = "I'm running low") {
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
    async rescheduleOrder(sid, date) { return this.query(`mutation RescheduleNextOrder($input: RescheduleNextOrderInput!) { rescheduleNextOrder(input: $input) { success } }`, { input: { subscriptionId: sid, newDate: date } }); }
    async updatePet(pid, input) { return this.query(`mutation EditPetSubmit($petId: Int!, $input: UpdatePetInput!) { updateMyPet(petId: $petId, input: $input) { id pets { id name birthday weight targetWeight activity condition } } }`, { petId: pid, input }); }
    async getPetDetails() { return this.query(`query { me { pets { id name weight size breeds { name } targetWeight gender birthday activity condition neutered suggestedCalories requiredCalories } } }`); }
    async listAvailableRecipes() { return this.query(`query { recipes { name displayName } }`); }
    async getRecipes() { return this.queryCustomer(`query { customer { pets { name foodRecipes { name } plan { id dailyFreshCalories freshFoodRatio } } upcomingTransitionAndRegularOrders { upcomingRegularOrder { avgDaysOfFood dailyPrice } } } }`); }
    async quoteRecipeChange(petId, recipes) { return this.queryCustomer(`query FetchChangeFreshRecipesQuote($input: ChangeFreshRecipesPlanQuoteInput!) { customer { changeFreshRecipesPlanQuote(input: $input) { dailyConsumptionPrice { original updated } selectedRecipes { displayName name } subscriptionFrequency { original updated } } } }`, { input: { petId, recipes } }); }
    async getOrderSizeQuotes() { return this.queryCustomer(`query { customer { id changeFreshOrderSizeQuotes { current { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice } max { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice } min { averageDailyConsumptionPrice dailyConsumptionPrice frequency regularOrderTotalConsumptionPrice yearlyConsumptionPrice } } freshSubscription { id nextDate } } }`); }
    async updateOrderSize(size) { return this.queryCustomer(`mutation UpdateOrderSize($input: ChangeFreshOrderSizeInput!) { changeFreshOrderSize(input: $input) { customer { id freshSubscription { nextDate } nextOrderToBeDelivered { deliveryWindow { earliestDesiredArrivalDate latestDesiredArrivalDate } } } } }`, { input: { orderSize: size } }); }
    async updateRecipes(planId, recipes) { return this.queryCustomer(`mutation UpdateFoodPlansRecipes($input: UpdateFoodPlansRecipesInput!) { updateFoodPlansRecipes(input: $input) { customer { freshSubscription { id status lastQuotedPrice { regularOrderTotalConsumptionPrice } } pets { foodRecipes { name } plan { id dailyFreshCalories } } } } }`, { input: { foodPlans: [{ id: planId, selectedRecipes: recipes }], freeFormFeedback: "" } }); }
    async cleanup() { if (activeBrowser) {
        try {
            await activeBrowser.close();
        }
        catch { }
        activeBrowser = null;
        activePage = null;
        routeInstalled = false;
    } }
}
function toolHandler(fn) {
    return async (...args) => {
        try {
            const data = await fn(...args);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    };
}
async function main() {
    const client = new FarmersDogClient();
    const server = new McpServer({ name: "farmersdog-mcp", version: "2.1.0" });
    server.tool("farmersdog_get_account", "Account overview: pets, subscriptions, orders, referral", {}, toolHandler(() => client.getAccount()));
    server.tool("farmersdog_next_delivery", "Next delivery date + subscription info", {}, toolHandler(() => client.getNextDelivery()));
    server.tool("farmersdog_delivery_history", "Past deliveries", { limit: z.number().optional().default(10) }, toolHandler(({ limit }) => client.getDeliveryHistory(limit)));
    server.tool("farmersdog_get_pets", "Registered pets", {}, toolHandler(() => client.getPets()));
    server.tool("farmersdog_get_pet_details", "Detailed pet info: weight, calories, breeds", {}, toolHandler(() => client.getPetDetails()));
    server.tool("farmersdog_available_dates", "Available reschedule dates. Call BEFORE reschedule.", {}, toolHandler(() => client.getAvailableDates()));
    server.tool("farmersdog_get_profile", "Customer profile (name, email)", {}, toolHandler(() => client.getProfile()));
    server.tool("farmersdog_get_orders", "Current + future + past orders with pricing/shipping", {}, toolHandler(() => client.getOrders()));
    server.tool("farmersdog_list_recipes", "All available recipes", {}, toolHandler(() => client.listAvailableRecipes()));
    server.tool("farmersdog_get_recipes", "Current pet recipes + pricing", {}, toolHandler(() => client.getRecipes()));
    server.tool("farmersdog_quote_recipe_change", "Price quote for recipe change", { petId: z.number(), recipes: z.array(z.object({ name: z.string(), displayName: z.string() })) }, toolHandler(({ petId, recipes }) => client.quoteRecipeChange(petId, recipes)));
    server.tool("farmersdog_get_order_size_quotes", "Order size options with pricing", {}, toolHandler(() => client.getOrderSizeQuotes()));
    server.tool("farmersdog_reschedule_delivery", "Reschedule via API", { subscriptionId: z.number(), newDate: z.string() }, toolHandler(({ subscriptionId, newDate }) => client.rescheduleOrder(subscriptionId, newDate)));
    server.tool("farmersdog_reschedule_delivery_ui", "Reschedule via UI (most reliable)", { targetWeek: z.string(), reason: z.string().optional().default("I'm running low") }, toolHandler(({ targetWeek, reason }) => client.rescheduleViaUI(targetWeek, reason)));
    server.tool("farmersdog_update_pet", "Update pet info", { petId: z.number(), birthday: z.string().optional(), weight: z.number().optional(), targetWeight: z.number().optional(), activity: z.number().optional(), condition: z.number().optional() }, toolHandler(({ petId, birthday, weight, targetWeight, activity, condition }) => {
        const input = {};
        if (birthday) {
            input.birthday = birthday;
            input.birthdayAccuracy = "date";
        }
        if (weight !== undefined)
            input.weight = weight;
        if (targetWeight !== undefined)
            input.targetWeight = targetWeight;
        if (activity !== undefined)
            input.activity = activity;
        if (condition !== undefined)
            input.condition = condition;
        return client.updatePet(petId, input);
    }));
    server.tool("farmersdog_update_recipes", "Change recipes. Call quote first.", { planId: z.number(), recipes: z.array(z.object({ name: z.string() })) }, toolHandler(({ planId, recipes }) => client.updateRecipes(planId, recipes)));
    server.tool("farmersdog_update_order_size", "Change order size (28=4wk, 56=8wk)", { orderSize: z.number() }, toolHandler(({ orderSize }) => client.updateOrderSize(orderSize)));
    process.on("SIGINT", async () => { await client.cleanup(); process.exit(0); });
    process.on("SIGTERM", async () => { await client.cleanup(); process.exit(0); });
    await server.connect(new StdioServerTransport());
}
main().catch(console.error);
