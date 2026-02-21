#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { chromium } from "playwright";
const BASE_URL = "https://core-api-customer.k8s.east.thefarmersdog.com";
let cachedToken = null;
class FarmersDogClient {
    client;
    email;
    password;
    browserbaseApiKey;
    browserbaseProjectId;
    constructor() {
        this.email = process.env.FARMERSDOG_EMAIL;
        this.password = process.env.FARMERSDOG_PASSWORD;
        this.browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
        this.browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
        this.client = axios.create({
            baseURL: BASE_URL,
            headers: {
                "Content-Type": "application/json",
                "Origin": "https://www.thefarmersdog.com",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
        });
    }
    async getToken() {
        // Check cached token
        if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
            return cachedToken.token;
        }
        // Try manual token from env
        const manualToken = process.env.FARMERSDOG_TOKEN;
        if (manualToken) {
            // Decode and check expiration
            try {
                const payload = JSON.parse(Buffer.from(manualToken.split('.')[1], 'base64').toString());
                if (payload.exp * 1000 > Date.now() + 60000) {
                    cachedToken = { token: manualToken, expiresAt: payload.exp * 1000 };
                    return manualToken;
                }
            }
            catch {
                // Invalid token, try to login
            }
        }
        // Try BrowserBase login
        if (this.email && this.password && this.browserbaseApiKey && this.browserbaseProjectId) {
            const token = await this.loginWithBrowserBase();
            if (token) {
                const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
                cachedToken = { token, expiresAt: payload.exp * 1000 };
                return token;
            }
        }
        throw new Error("No valid token available. Either:\n" +
            "1. Set FARMERSDOG_TOKEN with a valid JWT from browser\n" +
            "2. Set FARMERSDOG_EMAIL, FARMERSDOG_PASSWORD, BROWSERBASE_API_KEY, and BROWSERBASE_PROJECT_ID for automatic login");
    }
    async loginWithBrowserBase() {
        console.error("[farmersdog-mcp] Logging in via BrowserBase...");
        try {
            const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${this.browserbaseApiKey}&projectId=${this.browserbaseProjectId}`);
            const context = browser.contexts()[0];
            const page = context.pages()[0] || await context.newPage();
            await page.goto('https://www.thefarmersdog.com/login', { timeout: 30000 });
            await page.fill('input[type="email"]', this.email);
            await page.fill('input[type="password"]', this.password);
            // Wait for Turnstile to pass and button to be enabled
            const submit = await page.waitForSelector('button[type="submit"]:enabled', { timeout: 30000 });
            // Capture the login response
            let token = null;
            page.on('response', async (response) => {
                if (response.url().includes('/login') && response.url().includes('core-api')) {
                    try {
                        const data = await response.json();
                        if (data?.data?.loginCustomer?.token) {
                            token = data.data.loginCustomer.token;
                        }
                    }
                    catch { }
                }
            });
            await submit.click();
            // Wait for navigation or token
            await page.waitForURL('**/app**', { timeout: 15000 }).catch(() => { });
            // Give time for response handler
            await new Promise(r => setTimeout(r, 2000));
            await browser.close();
            if (token) {
                console.error("[farmersdog-mcp] Login successful!");
                return token;
            }
            console.error("[farmersdog-mcp] Login failed - no token received");
            return null;
        }
        catch (error) {
            console.error(`[farmersdog-mcp] BrowserBase login error: ${error.message}`);
            return null;
        }
    }
    async query(queryStr, variables = {}) {
        const token = await this.getToken();
        const response = await this.client.post("/", {
            query: queryStr,
            variables,
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (response.data.errors) {
            throw new Error(response.data.errors[0]?.message || "GraphQL error");
        }
        return response.data.data;
    }
    async queryCustomer(queryStr, variables = {}) {
        const token = await this.getToken();
        const response = await this.client.post("/customer-graphql", {
            query: queryStr,
            variables,
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (response.data.errors) {
            throw new Error(response.data.errors[0]?.message || "GraphQL error");
        }
        return response.data.data;
    }
    async getAccount() {
        return this.query(`
      query CustomerAccount {
        me {
          id
          status
          activePets: pets(petsInput: {active: true}) {
            id
            name
          }
          subscriptions {
            id
            status
            type
            frequency
            nextDate
            numberOfBoxes
            ordersConnection(first: 5) {
              edges {
                node {
                  id
                  shipDate
                  states
                  type
                  paymentStatus
                }
              }
            }
          }
          referralStats {
            discountPercentage
            referralCode
          }
        }
      }
    `);
    }
    async getNextDelivery() {
        return this.query(`
      query {
        me {
          subscriptions {
            id
            nextDate
            frequency
            status
            numberOfBoxes
          }
        }
      }
    `);
    }
    async getDeliveryHistory(limit = 10) {
        return this.query(`
      query {
        me {
          subscriptions {
            ordersConnection(first: ${limit}, shipmentStatuses: [delivered]) {
              edges {
                node {
                  id
                  shipDate
                  states
                  type
                  paymentStatus
                }
              }
            }
          }
        }
      }
    `);
    }
    async getPets() {
        return this.query(`
      query {
        me {
          pets {
            id
            name
          }
          activePets: pets(petsInput: {active: true}) {
            id
            name
          }
        }
      }
    `);
    }
    async getAvailableDates() {
        return this.query(`
      query FetchAvailableNextDatesSubscription {
        configuration {
          maxDelayDurationInDays
        }
        me {
          id
          availableNextDates
        }
      }
    `);
    }
    async getProfile() {
        return this.queryCustomer(`
      query CustomerAccount {
        customer {
          accountInformation {
            email
            firstName
            fullName
          }
          canViewDashboard
          canViewMergedPlanPage
        }
      }
    `);
    }
    async getOrders() {
        return this.queryCustomer(`
      query {
        customerOrders(futureOrderCount: 2) {
          current {
            id
            petNames
            pricing {
              cashTotal
              pricePerDay
              pricePerWeek
              total
            }
            scheduling {
              earliestDesiredArrivalDate
              latestDesiredArrivalDate
              isReschedulable
              rescheduleCutOffDate
            }
            shipping {
              status
              arrivalDate
              trackingURL
              address {
                addressLine1
                addressLine2
                city
                stateAbbreviation
                zip
              }
            }
            packing {
              numberOfFoodPacks
            }
          }
          future {
            id
            petNames
            pricing {
              cashTotal
              pricePerDay
              pricePerWeek
              total
            }
            scheduling {
              earliestDesiredArrivalDate
              latestDesiredArrivalDate
              isReschedulable
            }
            packing {
              numberOfFoodPacks
            }
          }
          past {
            id
            petNames
            pricing {
              cashTotal
              pricePerDay
            }
            shipping {
              status
              arrivalDate
            }
            packing {
              numberOfFoodPacks
            }
          }
        }
      }
    `);
    }
    async rescheduleOrder(subscriptionId, newDate) {
        return this.query(`
      mutation RescheduleNextOrder($input: RescheduleNextOrderInput!) {
        rescheduleNextOrder(input: $input) {
          success
        }
      }
    `, {
            input: {
                subscriptionId,
                newDate,
            }
        });
    }
    async updatePet(petId, input) {
        return this.query(`
      mutation EditPetSubmit($petId: Int!, $input: UpdatePetInput!) {
        updateMyPet(petId: $petId, input: $input) {
          id
          pets {
            id
            name
            birthday
            weight
            targetWeight
            activity
            condition
          }
        }
      }
    `, { petId, input });
    }
    async getPetDetails() {
        return this.query(`
      query {
        me {
          pets {
            id
            name
            weight
            size
            breeds { name }
            targetWeight
            gender
            birthday
            activity
            condition
            neutered
            suggestedCalories
            requiredCalories
          }
        }
      }
    `);
    }
    async listAvailableRecipes() {
        return this.query(`
      query {
        recipes {
          name
          displayName
        }
      }
    `);
    }
    async getRecipes() {
        return this.queryCustomer(`
      query {
        customer {
          pets {
            name
            foodRecipes {
              name
            }
            plan {
              id
              dailyFreshCalories
              freshFoodRatio
            }
          }
          upcomingTransitionAndRegularOrders {
            upcomingRegularOrder {
              avgDaysOfFood
              dailyPrice
            }
          }
        }
      }
    `);
    }
    async quoteRecipeChange(petId, recipes) {
        return this.queryCustomer(`
      query FetchChangeFreshRecipesQuote($input: ChangeFreshRecipesPlanQuoteInput!) {
        customer {
          changeFreshRecipesPlanQuote(input: $input) {
            dailyConsumptionPrice {
              original
              updated
            }
            selectedRecipes {
              displayName
              name
            }
            subscriptionFrequency {
              original
              updated
            }
          }
        }
      }
    `, { input: { petId, recipes } });
    }
    async getOrderSizeQuotes() {
        return this.queryCustomer(`
      query GetChangeOrderSizeQuotes {
        customer {
          id
          changeFreshOrderSizeQuotes {
            current {
              averageDailyConsumptionPrice
              dailyConsumptionPrice
              frequency
              regularOrderTotalConsumptionPrice
              yearlyConsumptionPrice
            }
            max {
              averageDailyConsumptionPrice
              dailyConsumptionPrice
              frequency
              regularOrderTotalConsumptionPrice
              yearlyConsumptionPrice
            }
            min {
              averageDailyConsumptionPrice
              dailyConsumptionPrice
              frequency
              regularOrderTotalConsumptionPrice
              yearlyConsumptionPrice
            }
          }
          freshSubscription {
            id
            nextDate
          }
        }
      }
    `);
    }
    async updateOrderSize(orderSize) {
        return this.queryCustomer(`
      mutation UpdateOrderSize($input: ChangeFreshOrderSizeInput!) {
        changeFreshOrderSize(input: $input) {
          customer {
            id
            freshSubscription {
              nextDate
            }
            nextOrderToBeDelivered {
              deliveryWindow {
                earliestDesiredArrivalDate
                latestDesiredArrivalDate
              }
            }
          }
        }
      }
    `, { input: { orderSize } });
    }
    async updateRecipes(planId, recipes) {
        return this.queryCustomer(`
      mutation UpdateFoodPlansRecipes($input: UpdateFoodPlansRecipesInput!) {
        updateFoodPlansRecipes(input: $input) {
          customer {
            freshSubscription {
              id
              status
              lastQuotedPrice {
                regularOrderTotalConsumptionPrice
              }
            }
            pets {
              foodRecipes {
                name
              }
              plan {
                id
                dailyFreshCalories
              }
            }
          }
        }
      }
    `, {
            input: {
                foodPlans: [{ id: planId, selectedRecipes: recipes }],
                freeFormFeedback: ""
            }
        });
    }
}
async function main() {
    const client = new FarmersDogClient();
    const server = new McpServer({
        name: "farmersdog-mcp",
        version: "1.0.0",
    });
    // Tool: Get account overview
    server.tool("get_account", "Get your Farmer's Dog account overview including pets, subscriptions, and recent orders", {}, async () => {
        try {
            const data = await client.getAccount();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get next delivery
    server.tool("next_delivery", "Get information about your next scheduled Farmer's Dog delivery", {}, async () => {
        try {
            const data = await client.getNextDelivery();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get delivery history
    server.tool("delivery_history", "Get your past Farmer's Dog delivery history", {
        limit: z.number().optional().default(10).describe("Number of past deliveries to retrieve"),
    }, async ({ limit }) => {
        try {
            const data = await client.getDeliveryHistory(limit);
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get pets
    server.tool("get_pets", "Get information about your pets registered with Farmer's Dog", {}, async () => {
        try {
            const data = await client.getPets();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get available dates
    server.tool("available_dates", "Get available dates for rescheduling your next delivery (up to 120 days out)", {}, async () => {
        try {
            const data = await client.getAvailableDates();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get profile
    server.tool("get_profile", "Get your Farmer's Dog customer profile (name, email)", {}, async () => {
        try {
            const data = await client.getProfile();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get orders with pricing
    server.tool("get_orders", "Get current and past orders with full pricing, shipping status, and delivery details", {}, async () => {
        try {
            const data = await client.getOrders();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Reschedule delivery
    server.tool("reschedule_delivery", "Reschedule your next Farmer's Dog delivery to a new date. Use available_dates first to see valid dates.", {
        subscriptionId: z.number().describe("Subscription ID (get from get_account)"),
        newDate: z.string().describe("New delivery date in YYYY-MM-DD format (must be from available_dates)"),
    }, async ({ subscriptionId, newDate }) => {
        try {
            const data = await client.rescheduleOrder(subscriptionId, newDate);
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Update pet info
    server.tool("update_pet", "Update pet information (birthday, weight, activity level, etc.)", {
        petId: z.number().describe("Pet ID (get from get_pets)"),
        birthday: z.string().optional().describe("Birthday in YYYY-MM-DD format"),
        weight: z.number().optional().describe("Weight in grams"),
        targetWeight: z.number().optional().describe("Target weight in grams"),
        activity: z.number().optional().describe("Activity level (1-5)"),
        condition: z.number().optional().describe("Body condition (1-9)"),
    }, async ({ petId, birthday, weight, targetWeight, activity, condition }) => {
        try {
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
            const data = await client.updatePet(petId, input);
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get pet details
    server.tool("get_pet_details", "Get detailed information about your pets including weight, activity level, and suggested calories", {}, async () => {
        try {
            const data = await client.getPetDetails();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: List all available recipes
    server.tool("list_recipes", "List all available Farmer's Dog recipes that can be selected", {}, async () => {
        try {
            const data = await client.listAvailableRecipes();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get recipes
    server.tool("get_recipes", "Get current recipes for your pets and pricing info. Available recipes: TURKEY, BEEF, CHICKEN, PORK, CHICKEN_OATS_COLLARDS (Chicken & Grain)", {}, async () => {
        try {
            const data = await client.getRecipes();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Quote recipe change
    server.tool("quote_recipe_change", "Get a price quote for changing recipes before confirming. Returns price difference and new frequency.", {
        petId: z.number().describe("Pet ID (get from get_pets)"),
        recipes: z.array(z.object({
            name: z.string().describe("Recipe name: TURKEY, BEEF, CHICKEN, PORK, or CHICKEN_OATS_COLLARDS"),
            displayName: z.string().describe("Display name: Turkey, Beef, Chicken, Pork, or Chicken & Grain")
        })).describe("Array of recipes to set (1-3 recipes)")
    }, async ({ petId, recipes }) => {
        try {
            const data = await client.quoteRecipeChange(petId, recipes);
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Update recipes
    server.tool("update_recipes", "Confirm recipe changes for a pet. Use quote_recipe_change first to see pricing impact.", {
        planId: z.number().describe("Plan ID (get from get_recipes -> plan.id)"),
        recipes: z.array(z.object({
            name: z.string().describe("Recipe name: TURKEY, BEEF, CHICKEN, PORK, or CHICKEN_OATS_COLLARDS")
        })).describe("Array of recipes to set (1-3 recipes)")
    }, async ({ planId, recipes }) => {
        try {
            const data = await client.updateRecipes(planId, recipes);
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Get order size quotes
    server.tool("get_order_size_quotes", "Get available order sizes with pricing comparison (current, min, max options)", {}, async () => {
        try {
            const data = await client.getOrderSizeQuotes();
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // Tool: Update order size
    server.tool("update_order_size", "Change your order size/frequency. Common values: 28 (4 weeks) or 56 (8 weeks). Larger orders = lower daily price.", {
        orderSize: z.number().describe("Order size in days (e.g., 28 for 4 weeks, 56 for 8 weeks)")
    }, async ({ orderSize }) => {
        try {
            const data = await client.updateOrderSize(orderSize);
            return {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch(console.error);
