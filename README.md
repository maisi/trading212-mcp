# trading212-mcp

MCP server (stdio) for the Trading 212 Public API.

## Status

- Trading endpoints are **gated** behind `TRADING212_ALLOW_TRADING=true`.
- Default environment: `demo`.

## Env vars

- `TRADING212_ENV`: `demo` | `live` (default: `demo`)
- `TRADING212_API_KEY`: API key (username)
- `TRADING212_API_SECRET`: API secret (password)
- `TRADING212_ALLOW_TRADING`: `true` to allow order placement/cancel (default: `false`)

## Run

```bash
npm i
TRADING212_ENV=demo TRADING212_API_KEY=... TRADING212_API_SECRET=... node server.mjs
```

## Tools

- `t212_cash`
- `t212_positions`
- `t212_orders`
- `t212_instruments_exchanges`
- `t212_raw`
- `t212_place_order` (gated)
- `t212_cancel_order` (gated)

