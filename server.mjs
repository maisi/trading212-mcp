#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";

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

function parseCsv(text) {
  // Minimal RFC4180-ish CSV parser (supports quoted fields + commas + escaped quotes)
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }

    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (c === "\n") {
      row.push(field);
      field = "";
      // trim CR
      if (row.length === 1 && row[0] === "") {
        row = [];
        continue;
      }
      rows.push(row.map((s) => (s.endsWith("\r") ? s.slice(0, -1) : s)));
      row = [];
      continue;
    }

    field += c;
  }

  // last line
  if (field.length || row.length) {
    row.push(field);
    rows.push(row.map((s) => (s.endsWith("\r") ? s.slice(0, -1) : s)));
  }

  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0];
  const dataRows = rows.slice(1);
  const objects = dataRows
    .filter((r) => r.some((x) => String(x ?? "").trim() !== ""))
    .map((r) => {
      const o = {};
      for (let j = 0; j < header.length; j++) o[header[j]] = r[j] ?? "";
      return o;
    });
  return { header, rows: objects };
}

async function requestTransactionsReport({ timeFrom, timeTo }) {
  const payload = {
    timeFrom,
    timeTo,
    dataIncluded: {
      includeDividends: false,
      includeInterest: false,
      includeOrders: false,
      includeTransactions: true,
    },
  };

  const enq = await t212Fetch("/equity/history/exports", { method: "POST", body: payload });
  if (!enq?.reportId) throw new Error(`Unexpected response from exports POST: ${JSON.stringify(enq).slice(0, 500)}`);
  return enq.reportId;
}

async function listReports() {
  const reports = await t212Fetch("/equity/history/exports");
  if (!Array.isArray(reports)) throw new Error(`Unexpected response from exports GET: ${JSON.stringify(reports).slice(0, 500)}`);
  return reports;
}

async function getReportById(reportId) {
  const reports = await listReports();
  const hit = reports.find((r) => String(r.reportId) === String(reportId));
  return hit ?? null;
}

async function fetchTransactionsCsv({ timeFrom, timeTo, waitSeconds = 20 }) {
  const reportId = await requestTransactionsReport({ timeFrom, timeTo });

  const deadline = Date.now() + waitSeconds * 1000;
  let report = null;
  while (Date.now() < deadline) {
    report = await getReportById(reportId);
    if (report?.status === "Finished" && report?.downloadLink) break;
    // avoid hammering the 1/min limit: sleep 5s
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!report?.downloadLink) {
    return { reportId, status: report?.status ?? "Unknown", downloadLink: report?.downloadLink ?? null, csv: null };
  }

  const res = await fetch(report.downloadLink);
  const csvText = await res.text();
  if (!res.ok) throw new Error(`CSV download failed ${res.status}: ${csvText.slice(0, 300)}`);
  return { reportId, status: report.status, downloadLink: report.downloadLink, csv: csvText };
}

function shJson(cmd, args) {
  const out = execFileSync(cmd, args, { encoding: "utf8" });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const server = new Server({ name: "trading212-mcp", version: "0.2.0" }, { capabilities: { tools: {} } });

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
        name: "t212_place_order_market",
        description:
          "Place a MARKET order (requires TRADING212_ALLOW_TRADING=true). Quantity <0 sells.",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            quantity: { type: "number", description: "Negative quantity = sell" },
            extendedHours: { type: "boolean" },
          },
          required: ["ticker", "quantity"],
        },
      },
      {
        name: "t212_place_order_limit",
        description: "Place a LIMIT order (requires TRADING212_ALLOW_TRADING=true). Quantity <0 sells.",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            quantity: { type: "number" },
            limitPrice: { type: "number" },
            timeValidity: { type: "string", description: "DAY|GTC (depends on API)" },
          },
          required: ["ticker", "quantity", "limitPrice"],
        },
      },
      {
        name: "t212_history_transactions",
        description:
          "Fetch movements (deposit/withdraw/fee/transfer) via /equity/history/transactions (NOT card-level merchant details).",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max 50" },
            cursor: { type: "string" },
            time: { type: "string", description: "Start time (ISO)" },
          },
        },
      },
      {
        name: "t212_export_transactions_csv",
        description:
          "Generate and download the Transactions CSV export (contains card debits incl. merchant/category).",
        inputSchema: {
          type: "object",
          properties: {
            timeFrom: { type: "string", description: "ISO datetime" },
            timeTo: { type: "string", description: "ISO datetime" },
            waitSeconds: { type: "number", description: "Max wait for report completion (default 20)" },
          },
          required: ["timeFrom", "timeTo"],
        },
      },
      {
        name: "t212_card_transactions",
        description:
          "Return only card-related rows (Card debit / Spending cashback) from the Transactions CSV export.",
        inputSchema: {
          type: "object",
          properties: {
            timeFrom: { type: "string" },
            timeTo: { type: "string" },
            waitSeconds: { type: "number" },
          },
          required: ["timeFrom", "timeTo"],
        },
      },
      {
        name: "t212_budget_import_card_transactions",
        description:
          "Import card-related rows into Budget via budget.add_transaction. Uses memo 't212:<ID>' for dedup. Dry-run by default.",
        inputSchema: {
          type: "object",
          properties: {
            budgetAccountId: { type: "string", description: "Budget account UUID" },
            timeFrom: { type: "string" },
            timeTo: { type: "string" },
            dryRun: { type: "boolean", description: "Default true" },
            waitSeconds: { type: "number" },
          },
          required: ["budgetAccountId", "timeFrom", "timeTo"],
        },
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
    if (!T212_ALLOW_TRADING) throw new Error("Trading disabled. Set TRADING212_ALLOW_TRADING=true.");
    const schema = z.object({ id: z.number().int().positive() });
    const { id } = schema.parse(args);
    const data = await t212Fetch(`/equity/orders/${id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_place_order_market") {
    if (!T212_ALLOW_TRADING) throw new Error("Trading disabled. Set TRADING212_ALLOW_TRADING=true.");
    const schema = z.object({ ticker: z.string().min(1), quantity: z.number(), extendedHours: z.boolean().optional() });
    const { ticker, quantity, extendedHours } = schema.parse(args);
    const payload = { ticker, quantity, ...(extendedHours !== undefined ? { extendedHours } : {}) };
    const data = await t212Fetch("/equity/orders/market", { method: "POST", body: payload });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_place_order_limit") {
    if (!T212_ALLOW_TRADING) throw new Error("Trading disabled. Set TRADING212_ALLOW_TRADING=true.");
    const schema = z.object({
      ticker: z.string().min(1),
      quantity: z.number(),
      limitPrice: z.number(),
      timeValidity: z.string().optional(),
    });
    const { ticker, quantity, limitPrice, timeValidity } = schema.parse(args);
    const payload = { ticker, quantity, limitPrice, ...(timeValidity ? { timeValidity } : {}) };
    const data = await t212Fetch("/equity/orders/limit", { method: "POST", body: payload });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_history_transactions") {
    const schema = z.object({ limit: z.number().int().positive().max(50).optional(), cursor: z.string().optional(), time: z.string().optional() }).optional();
    const { limit, cursor, time } = schema?.parse(args) ?? {};
    const data = await t212Fetch("/equity/history/transactions", { searchParams: { limit, cursor, time } });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "t212_export_transactions_csv") {
    const schema = z.object({ timeFrom: z.string().min(10), timeTo: z.string().min(10), waitSeconds: z.number().int().positive().max(300).optional() });
    const { timeFrom, timeTo, waitSeconds = 20 } = schema.parse(args);
    const out = await fetchTransactionsCsv({ timeFrom, timeTo, waitSeconds });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "t212_card_transactions") {
    const schema = z.object({ timeFrom: z.string().min(10), timeTo: z.string().min(10), waitSeconds: z.number().int().positive().max(300).optional() });
    const { timeFrom, timeTo, waitSeconds = 20 } = schema.parse(args);
    const out = await fetchTransactionsCsv({ timeFrom, timeTo, waitSeconds });
    if (!out.csv) return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };

    const parsed = parseCsv(out.csv);
    const rows = parsed.rows;

    const cardRows = rows.filter((r) => {
      const a = (r.Action ?? "").trim();
      return a === "Card debit" || a === "Spending cashback" || a === "Card credit";
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ reportId: out.reportId, timeFrom, timeTo, count: cardRows.length, items: cardRows }, null, 2),
        },
      ],
    };
  }

  if (name === "t212_budget_import_card_transactions") {
    const schema = z.object({
      budgetAccountId: z.string().min(10),
      timeFrom: z.string().min(10),
      timeTo: z.string().min(10),
      dryRun: z.boolean().optional(),
      waitSeconds: z.number().int().positive().max(300).optional(),
    });
    const { budgetAccountId, timeFrom, timeTo, dryRun = true, waitSeconds = 20 } = schema.parse(args);

    const out = await fetchTransactionsCsv({ timeFrom, timeTo, waitSeconds });
    if (!out.csv) {
      return { content: [{ type: "text", text: JSON.stringify({ ...out, dryRun }, null, 2) }] };
    }

    const parsed = parseCsv(out.csv);
    const rows = parsed.rows;
    const cardRows = rows.filter((r) => {
      const a = (r.Action ?? "").trim();
      return a === "Card debit" || a === "Spending cashback" || a === "Card credit";
    });

    // No dedup here by design (Martin preference). Budget tool should dedup based on memo/amount/etc.
    const imported = [];
    const skipped = [];

    for (const r of cardRows) {
      const id = String(r.ID ?? r.Id ?? "").trim();
      const memo = `t212:${id}`;
      if (!id) {
        skipped.push({ id, reason: "missing id", row: r });
        continue;
      }

      // CSV columns:
      // Action,Time,Notes,ID,Total,Currency (Total),Merchant name,Merchant category
      const time = String(r.Time ?? "").trim();
      const date = time.slice(0, 10); // YYYY-MM-DD
      // Martin preference: do NOT set payee. Put merchant into memo.
      const merchant = String(r["Merchant name"] ?? "").replace(/\s+/g, " ").trim();
      const amountStr = String(r.Total ?? "").replace(/,/g, ".").trim();
      const amount = Number(amountStr);
      if (!Number.isFinite(amount)) {
        skipped.push({ id, reason: `bad amount: ${amountStr}`, row: r });
        continue;
      }

      const memoFull = merchant ? `${memo} | ${merchant}` : memo;

      if (dryRun) {
        imported.push({ id, dryRun: true, date, amount, memo: memoFull });
        continue;
      }

      // Call budget.add_transaction
      const argsObj = { account_id: budgetAccountId, date, amount, memo: memoFull, cleared: "cleared" };
      const res = shJson("mcporter", ["call", "budget.add_transaction", "--args", JSON.stringify(argsObj)]);
      imported.push({ id, date, amount, memo: memoFull, result: res });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ reportId: out.reportId, timeFrom, timeTo, dryRun, importedCount: imported.length, skippedCount: skipped.length, imported, skipped }, null, 2),
        },
      ],
    };
  }

  if (name === "t212_raw") {
    const schema = z.object({
      path: z.string().min(1),
      method: z.string().optional(),
      query: z.record(z.any()).optional(),
      body: z.record(z.any()).optional(),
    });
    const { path, method = "GET", query, body } = schema.parse(args);
    const data = await t212Fetch(path, { method: method.toUpperCase(), searchParams: query, body });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
