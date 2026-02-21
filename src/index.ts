#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosInstance } from "axios";
import { chromium } from "playwright";

const BASE_URL = "https://core-api-customer.k8s.east.thefarmersdog.com";

interface TokenData {
  token: string;
  expiresAt: number;
}

let cachedToken: TokenData | null = null;

class FarmersDogClient {
  private client: AxiosInstance;
  private email?: string;
  private password?: string;
  private browserbaseApiKey?: string;
  private browserbaseProjectId?: string;

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

  private async getToken(): Promise<string> {
    // Check cached token
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
      return cachedToken.token;
    }

    // Try manual token from env
    const manualToken = process.env.FARMERSDOG_TOKEN;
    if (manualToken) {
      // Decode and check expiration
      try {
        const payload = JSON.parse(
          Buffer.from(manualToken.split('.')[1], 'base64').toString()
        );
        if (payload.exp * 1000 > Date.now() + 60000) {
          cachedToken = { token: manualToken, expiresAt: payload.exp * 1000 };
          return manualToken;
        }
      } catch {
        // Invalid token, try to login
      }
    }

    // Try BrowserBase login
    if (this.email && this.password && this.browserbaseApiKey && this.browserbaseProjectId) {
      const token = await this.loginWithBrowserBase();
      if (token) {
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString()
        );
        cachedToken = { token, expiresAt: payload.exp * 1000 };
        return token;
      }
    }

    throw new Error(
      "No valid token available. Either:\n" +
      "1. Set FARMERSDOG_TOKEN with a valid JWT from browser\n" +
      "2. Set FARMERSDOG_EMAIL, FARMERSDOG_PASSWORD, BROWSERBASE_API_KEY, and BROWSERBASE_PROJECT_ID for automatic login"
    );
  }

  private async loginWithBrowserBase(): Promise<string | null> {
    console.error("[farmersdog-mcp] Logging in via BrowserBase...");
    
    try {
      const browser = await chromium.connectOverCDP(
        `wss://connect.browserbase.com?apiKey=${this.browserbaseApiKey}&projectId=${this.browserbaseProjectId}`
      );

      const context = browser.contexts()[0];
      const page = context.pages()[0] || await context.newPage();

      await page.goto('https://www.thefarmersdog.com/login', { timeout: 30000 });
      await page.fill('input[type="email"]', this.email!);
      await page.fill('input[type="password"]', this.password!);

      // Wait for Turnstile to pass and button to be enabled
      const submit = await page.waitForSelector('button[type="submit"]:enabled', { timeout: 30000 });
      
      // Capture the login response
      let token: string | null = null;
      page.on('response', async (response) => {
        if (response.url().includes('/login') && response.url().includes('core-api')) {
          try {
            const data = await response.json();
            if (data?.data?.loginCustomer?.token) {
              token = data.data.loginCustomer.token;
            }
          } catch {}
        }
      });

      await submit.click();
      
      // Wait for navigation or token
      await page.waitForURL('**/app**', { timeout: 15000 }).catch(() => {});
      
      // Give time for response handler
      await new Promise(r => setTimeout(r, 2000));

      await browser.close();
      
      if (token) {
        console.error("[farmersdog-mcp] Login successful!");
        return token;
      }
      
      console.error("[farmersdog-mcp] Login failed - no token received");
      return null;
    } catch (error) {
      console.error(`[farmersdog-mcp] BrowserBase login error: ${(error as Error).message}`);
      return null;
    }
  }

  async query<T>(queryStr: string, variables: Record<string, unknown> = {}): Promise<T> {
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

  async queryCustomer<T>(queryStr: string, variables: Record<string, unknown> = {}): Promise<T> {
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

  async getAccount(): Promise<unknown> {
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

  async getNextDelivery(): Promise<unknown> {
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

  async getDeliveryHistory(limit: number = 10): Promise<unknown> {
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

  async getPets(): Promise<unknown> {
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

  async getAvailableDates(): Promise<unknown> {
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

  async getProfile(): Promise<unknown> {
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

  async rescheduleOrder(subscriptionId: number, newDate: string): Promise<unknown> {
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
}

async function main() {
  const client = new FarmersDogClient();

  const server = new McpServer({
    name: "farmersdog-mcp",
    version: "1.0.0",
  });

  // Tool: Get account overview
  server.tool(
    "get_account",
    "Get your Farmer's Dog account overview including pets, subscriptions, and recent orders",
    {},
    async () => {
      try {
        const data = await client.getAccount();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get next delivery
  server.tool(
    "next_delivery",
    "Get information about your next scheduled Farmer's Dog delivery",
    {},
    async () => {
      try {
        const data = await client.getNextDelivery();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get delivery history
  server.tool(
    "delivery_history",
    "Get your past Farmer's Dog delivery history",
    {
      limit: z.number().optional().default(10).describe("Number of past deliveries to retrieve"),
    },
    async ({ limit }) => {
      try {
        const data = await client.getDeliveryHistory(limit);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get pets
  server.tool(
    "get_pets",
    "Get information about your pets registered with Farmer's Dog",
    {},
    async () => {
      try {
        const data = await client.getPets();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get available dates
  server.tool(
    "available_dates",
    "Get available dates for rescheduling your next delivery (up to 120 days out)",
    {},
    async () => {
      try {
        const data = await client.getAvailableDates();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Get profile
  server.tool(
    "get_profile",
    "Get your Farmer's Dog customer profile (name, email)",
    {},
    async () => {
      try {
        const data = await client.getProfile();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: Reschedule delivery
  server.tool(
    "reschedule_delivery",
    "Reschedule your next Farmer's Dog delivery to a new date. Use available_dates first to see valid dates.",
    {
      subscriptionId: z.number().describe("Subscription ID (get from get_account)"),
      newDate: z.string().describe("New delivery date in YYYY-MM-DD format (must be from available_dates)"),
    },
    async ({ subscriptionId, newDate }) => {
      try {
        const data = await client.rescheduleOrder(subscriptionId, newDate);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
