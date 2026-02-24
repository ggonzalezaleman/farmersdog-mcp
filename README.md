# farmersdog-mcp

MCP server for The Farmer's Dog pet food subscription management.

## Architecture

Farmer's Dog has aggressive Cloudflare protection that blocks all non-browser API calls. This MCP uses a two-layer approach:

1. **Login**: Browserbase (remote browser with residential IPs) + 2Captcha for Turnstile solving (~11s)
2. **API calls**: Route interception — hijacks the React app's own GraphQL requests via Playwright `route.continue()` with body swap. The browser's own request carries all Cloudflare cookies/clearance.

### Key learnings
- Turnstile sitekey: `0x4AAAAAAAWwgggf84d3DU0J` (not in HTML, extracted from challenge URL)
- Turnstile clears ALL form fields on completion → fill email + password AFTER solving
- `route.fetch()` gets blocked by Cloudflare; `route.continue()` with body swap works because it reuses the browser's existing connection
- Session persistence via `~/.farmersdog-session.json` avoids 35s+ cold starts

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
| `TWOCAPTCHA_API_KEY` | Recommended | 2Captcha API key (~$0.003/solve) |

Without 2Captcha, falls back to natural Turnstile waiting (~50% success rate).

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
