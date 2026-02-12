#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const T212_ENV = process.env.TRADING212_ENV ?? "demo"; // demo | live
const T212_API_KEY = process.env.TRADING212_API_KEY;
const T212_API_SECRET = process.env.TRADING212_API_SECRET;
const T212_ALLOW_TRADING = (process.env.TRADING212_ALLOW_TRADING ?? "false").toLowerCase() === "true";

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function baseUrl() {
  const env = (T212_ENV || "demo").toLowerCase();
  if (env === "live") return "https://live.trading212.com/api/v0";
  return "https://demo.trading212.com/api/v0";
}

function authHeader() {
  const key = requireEnv("TRADING212_API_KEY", T212_API_KEY);
  const secret = requireEnv("TRADING212_API_SECRET", T212_API_SECRET);
  const token = Buffer.from(`${key}:${secret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function t212Fetch(path, { method = "GET", searchParams, body } = {}) {
  const url = new URL(`${baseUrl()}${path.startsWith("/") ? "" : "/"}${path}`);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: authHeader(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Trading212 API error ${res.status}: ${text.slice(0, 800)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = new Server(
  { name: "trading212-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "t212_cash",
        description: "Get Trading212 equity account cash balance.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "t212_positions",
        description: "Get open positions (optional filter by ticker).",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "Optional ticker, e.g. AAPL_US_EQ" },
          },
        },
      },
      {
        name: "t212_orders",
        description: "List active orders.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "t212_cancel_order",
        description: "Cancel an order by id (requires TRADING212_ALLOW_TRADING=true).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Order id" },
          },
          required: ["id"],
        },
      },
      {
        name: "t212_place_order",
        description:
          "Place an order (best-effort wrapper; requires TRADING212_ALLOW_TRADING=true). Quantity <0 sells. Fields depend on Trading212 API.",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "Instrument ticker, e.g. AAPL_US_EQ" },
            quantity: { type: "number", description: "Shares quantity. Negative = sell." },
            limitPrice: { type: "number", description: "Optional limit price" },
            stopPrice: { type: "number", description: "Optional stop price" },
            timeValidity: { type: "string", description: "Optional time validity (e.g. DAY/GTC depending on API)" },
            extendedHours: { type: "boolean", description: "Optional" },
          },
          required: ["ticker", "quantity"],
        },
      },
      {
        name: "t212_instruments_exchanges",
        description: "List exchanges (if supported by the API version).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "t212_raw",
        description: "Raw Trading212 API call for endpoints not yet wrapped. Path is relative to /api/v0 (e.g. /equity/positions).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            method: { type: "string", description: "GET|POST|DELETE (default GET)" },
            query: { type: "object", additionalProperties: true },
            body: { type: "object", additionalProperties: true },
          },
          required: ["path"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};

  if (name === "t212_cash") {
    const data = await t212Fetch("/equity/account/cash");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_positions") {
    const schema = z.object({ ticker: z.string().min(1).optional() }).optional();
    const { ticker } = schema?.parse(args) ?? {};
    const data = await t212Fetch("/equity/positions", { searchParams: { ticker } });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_orders") {
    const data = await t212Fetch("/equity/orders");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_cancel_order") {
    if (!T212_ALLOW_TRADING) throw new Error("Trading disabled. Set TRADING212_ALLOW_TRADING=true to allow cancelling/placing orders.");
    const schema = z.object({ id: z.number().int().positive() });
    const { id } = schema.parse(args);
    const data = await t212Fetch(`/equity/orders/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_place_order") {
    if (!T212_ALLOW_TRADING) throw new Error("Trading disabled. Set TRADING212_ALLOW_TRADING=true to allow cancelling/placing orders.");
    const schema = z.object({
      ticker: z.string().min(1),
      quantity: z.number(),
      limitPrice: z.number().optional(),
      stopPrice: z.number().optional(),
      timeValidity: z.string().optional(),
      extendedHours: z.boolean().optional(),
    });
    const { ticker, quantity, limitPrice, stopPrice, timeValidity, extendedHours } = schema.parse(args);

    // NOTE: This payload is based on the public docs conventions, but may need adjusting.
    const payload = {
      ticker,
      quantity,
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      ...(stopPrice !== undefined ? { stopPrice } : {}),
      ...(timeValidity !== undefined ? { timeValidity } : {}),
      ...(extendedHours !== undefined ? { extendedHours } : {}),
    };

    const data = await t212Fetch("/equity/orders", { method: "POST", body: payload });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_instruments_exchanges") {
    const data = await t212Fetch("/equity/instruments/exchanges");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_raw") {
    const schema = z.object({
      path: z.string().min(1),
      method: z.string().optional(),
      query: z.record(z.any()).optional(),
      body: z.record(z.any()).optional(),
    });
    const { path, method = "GET", query, body } = schema.parse(args);
    const data = await t212Fetch(path, {
      method: method.toUpperCase(),
      searchParams: query,
      body,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
