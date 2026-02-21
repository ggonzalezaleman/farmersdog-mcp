# The Farmer's Dog MCP Server

MCP server for managing your Farmer's Dog pet food subscription.

## Features (16 tools)

### Account & Profile
- **get_account** - Account overview (pets, subscriptions, orders)
- **get_profile** - Customer profile (name, email)
- **get_pets** - List of pets
- **get_pet_details** - Detailed pet info (weight, calories, activity)
- **update_pet** - Update pet info (birthday, weight, activity, etc.)

### Deliveries & Orders
- **next_delivery** - Next scheduled delivery
- **delivery_history** - Past deliveries
- **get_orders** - Current and past orders with full pricing
- **available_dates** - Available dates for rescheduling
- **reschedule_delivery** - Change delivery date

### Recipes
- **list_recipes** - All available recipes catalog
- **get_recipes** - Current recipes for your pet
- **quote_recipe_change** - Get price quote before changing recipes
- **update_recipes** - Confirm recipe changes

### Order Size
- **get_order_size_quotes** - Compare order size options (28 vs 56 days)
- **update_order_size** - Change order frequency

## Setup

### Option 1: Automatic Login with BrowserBase (Recommended)

BrowserBase provides free browser sessions that bypass Cloudflare Turnstile.

1. **Create a free BrowserBase account** at [browserbase.com](https://browserbase.com)
2. **Get your credentials** from the dashboard (API Key + Project ID)
3. **Configure environment variables:**

```bash
export FARMERSDOG_EMAIL="your@email.com"
export FARMERSDOG_PASSWORD="yourpassword"
export BROWSERBASE_API_KEY="bb_live_xxx"
export BROWSERBASE_PROJECT_ID="xxx-xxx-xxx"
```

### Option 2: Manual Token

```bash
export FARMERSDOG_TOKEN="eyJhbG..."  # Get from browser DevTools
```

⚠️ Tokens expire every ~15 hours.

## Installation

```bash
npm install -g farmersdog-mcp-server
```

Or run directly:

```bash
npx farmersdog-mcp-server
```

## MCP Configuration

Add to your MCP client config:

```json
{
  "farmersdog": {
    "command": "npx",
    "args": ["farmersdog-mcp-server"],
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

1. MCP checks for valid cached JWT token
2. If expired, uses BrowserBase to open a real browser
3. Fills login form, Turnstile passes (residential IP)
4. Captures JWT, caches for ~15h
5. Auto-refreshes when needed

## Available Recipes

| Code | Name |
|------|------|
| TURKEY | Turkey |
| BEEF | Beef |
| PORK | Pork |
| CHICKEN_AND_GREENS | Chicken |
| CHICKEN_OATS_COLLARDS | Chicken & Grain |
| PORK_GRAIN | Pork & Grain |
| BEEF_GRAIN | Beef & Grain |
| LOW_FAT_CHICKEN | Low Fat Chicken |

## Order Sizes

- **28 days** - Smaller, more frequent orders (higher $/day)
- **56 days** - Larger orders, better value (lower $/day, saves ~$193/year)

## Cost

- **BrowserBase Free Tier:** ~100 sessions/month
- **Usage:** ~2 logins/day = ~60 sessions/month
- **Result:** Completely free for normal use

## License

MIT
