# The Farmer's Dog MCP Server

MCP server for managing your Farmer's Dog pet food subscription.

## Features

- **get_account** - Get account overview (pets, subscriptions, recent orders)
- **next_delivery** - Check your next scheduled delivery
- **delivery_history** - View past deliveries
- **get_pets** - Get info about your registered pets
- **get_profile** - Get your profile (name, email)
- **available_dates** - Get available dates for rescheduling
- **reschedule_delivery** - Reschedule your next delivery date

## Setup

### Option 1: Automatic Login with BrowserBase (Recommended)

BrowserBase provides free browser sessions that bypass Cloudflare Turnstile.

1. **Create a free BrowserBase account** at [browserbase.com](https://browserbase.com)
2. **Get your credentials** from the dashboard:
   - API Key
   - Project ID

3. **Configure environment variables:**

```bash
export FARMERSDOG_EMAIL="your@email.com"
export FARMERSDOG_PASSWORD="yourpassword"
export BROWSERBASE_API_KEY="bb_live_xxx"
export BROWSERBASE_PROJECT_ID="xxx-xxx-xxx"
```

4. **Run the server:**

```bash
npm start
```

The MCP will automatically log in when needed and refresh the token when it expires (~every 15 hours).

### Option 2: Manual Token

If you don't want to create a BrowserBase account:

1. Log in at [thefarmersdog.com](https://www.thefarmersdog.com/login)
2. Open DevTools (F12) → Network tab
3. Look for requests to `core-api-customer.k8s.east.thefarmersdog.com`
4. Copy the `Authorization: Bearer <token>` header value

```bash
export FARMERSDOG_TOKEN="eyJhbG..."
```

⚠️ **Note:** Tokens expire every ~15 hours. You'll need to manually refresh.

## mcporter Configuration

Add to your MCP config:

```json
{
  "farmersdog": {
    "command": "node",
    "args": ["/path/to/farmersdog-mcp/dist/index.js"],
    "env": {
      "FARMERSDOG_EMAIL": "your@email.com",
      "FARMERSDOG_PASSWORD": "yourpassword",
      "BROWSERBASE_API_KEY": "bb_live_xxx",
      "BROWSERBASE_PROJECT_ID": "xxx-xxx-xxx"
    }
  }
}
```

## How It Works

1. When you call any tool, the MCP checks if it has a valid token
2. If no token or expired, it uses BrowserBase to:
   - Open a real browser session
   - Navigate to the login page
   - Fill in credentials
   - Wait for Cloudflare Turnstile to pass
   - Capture the JWT token
3. The token is cached for subsequent calls
4. When it expires (~15h), it automatically re-logs in

## API Reference

Base URL: `https://core-api-customer.k8s.east.thefarmersdog.com/`

### Endpoints
- `/` - Main GraphQL endpoint (subscriptions, orders, pets)
- `/customer-graphql` - Customer profile endpoint
- `/login` - Authentication endpoint

### Key Types
- **MyUserView** - User account
- **MySubscriptionView** - Subscription details
- **MyOrderView** - Order/delivery info
- **MyPetView** - Pet information

## Cost

- **BrowserBase Free Tier:** ~100 sessions/month
- **Usage:** ~2 logins/day = ~60 sessions/month
- **Result:** Completely free for normal use

## Troubleshooting

### "No valid token available"
- Check your credentials are correct
- Verify BrowserBase API key and Project ID
- Try logging in manually at thefarmersdog.com to verify password

### BrowserBase timeout
- The free tier has rate limits
- Wait a few minutes and try again
- Consider upgrading if you need more sessions
