# farmersdog-mcp

MCP server for The Farmer's Dog pet food subscription management.

## Architecture

Uses Browserbase (remote browser) for authentication and API access, with optional 2Captcha for CAPTCHA solving.

## Setup

```bash
npm install
npm run build
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `FARMERSDOG_EMAIL` | Yes | Account email |
| `FARMERSDOG_PASSWORD` | Yes | Account password |
| `BROWSERBASE_API_KEY` | Yes | Browserbase API key |
| `BROWSERBASE_PROJECT_ID` | Yes | Browserbase project ID |
| `TWOCAPTCHA_API_KEY` | Recommended | 2Captcha API key for reliable CAPTCHA solving |

## Tools (17)

### Read-only
- `farmersdog_get_account` — Account overview
- `farmersdog_next_delivery` — Next delivery date
- `farmersdog_delivery_history` — Past deliveries
- `farmersdog_get_pets` — Registered pets
- `farmersdog_get_pet_details` — Detailed pet info
- `farmersdog_available_dates` — Reschedule date options
- `farmersdog_get_profile` — Customer profile
- `farmersdog_get_orders` — Orders with pricing/shipping
- `farmersdog_list_recipes` — Available recipes
- `farmersdog_get_recipes` — Current pet recipes
- `farmersdog_quote_recipe_change` — Price quote for recipe change
- `farmersdog_get_order_size_quotes` — Order size pricing

### Mutations
- `farmersdog_reschedule_delivery` — Reschedule via API
- `farmersdog_reschedule_delivery_ui` — Reschedule via UI (most reliable)
- `farmersdog_update_pet` — Update pet info
- `farmersdog_update_recipes` — Change recipes
- `farmersdog_update_order_size` — Change order size
