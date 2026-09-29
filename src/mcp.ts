#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GateError } from "./errors.js";
import { formatDecision, formatLedger } from "./format.js";
import { approve, decide, deny, evaluate, record, summarize } from "./gate.js";
import { loadPolicy, resolveConfigPath } from "./policy.js";
import { probe } from "./probe.js";
import type { Decision, Fulfilment, Settlement } from "./types.js";

const CallFields = {
  challenge: z
    .string()
    .optional()
    .describe("x402 challenge as JSON text, or the base64 PAYMENT-REQUIRED header value. Omit this to pass the flat fields instead."),
  resource: z.string().optional().describe("http(s) URL being paid. Required when the challenge has no resource. Also checked against the quoted URL."),
  amount: z.string().optional().describe('Atomic units as a string, for example "10000" for 0.01 of a 6-decimal token.'),
  network: z.string().optional().describe("Network id exactly as the merchant sent it, usually a CAIP-2 id such as eip155:84532."),
  asset: z.string().optional().describe("Asset identifier from the challenge, often a token contract."),
  pay_to: z.string().optional().describe("Payment recipient from the challenge."),
  scheme: z.string().optional().describe('Payment scheme. Only "exact" can be approved.'),
  max_timeout_seconds: z.number().int().positive().optional().describe("Challenge lifetime. The reservation will not outlive this or the policy TTL."),
  description: z.string().max(240).optional().describe("Short description stored with the decision."),
  idempotency_key: z
    .string()
    .optional()
    .describe("Stable key for this call. Reuse it on retry so the budget is reserved once."),
  accept_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("When the challenge offers several exact options, pick this index. Default: the first option on an allowed network."),
};

function challengeInput(args: {
  challenge?: string;
  resource?: string;
  amount?: string;
  network?: string;
  asset?: string;
  pay_to?: string;
  scheme?: string;
  max_timeout_seconds?: number;
  description?: string;
}): unknown {
  if (args.challenge) return args.challenge;
  const missing = [
    ["resource", args.resource],
    ["amount", args.amount],
    ["network", args.network],
    ["asset", args.asset],
    ["pay_to", args.pay_to],
  ]
    .filter((pair) => !pair[1])
    .map((pair) => pair[0]);
  if (missing.length > 0) {
    throw new GateError(
      "usage",
      `Pass challenge, or all of ${missing.join(", ")}. The flat fields are resource, amount, network, asset, and pay_to.`,
    );
  }
  return {
    scheme: args.scheme ?? "exact",
    network: args.network,
    amount: args.amount,
    asset: args.asset,
    payTo: args.pay_to,
    resource: args.resource,
    maxTimeoutSeconds: args.max_timeout_seconds,
    description: args.description ?? "",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function toolResult(decision: Decision) {
  return {
    content: [{ type: "text" as const, text: formatDecision(decision) }],
    structuredContent: asRecord(decision),
  };
}

function toolError(err: unknown) {
  const message = err instanceof GateError
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function fulfilmentOf(args: { fulfilment?: Fulfilment; fulfillment?: Fulfilment }): Fulfilment {
  if (args.fulfilment && args.fulfillment && args.fulfilment !== args.fulfillment) {
    throw new GateError("usage", "fulfilment and fulfillment disagree. Pass one of them.");
  }
  const value = args.fulfilment ?? args.fulfillment;
  if (value !== "accepted" && value !== "rejected" && value !== "unknown") {
    throw new GateError("usage", "fulfilment must be accepted, rejected, or unknown.");
  }
  return value;
}

export function createServer(configPath: string): McpServer {
  const policy = loadPolicy(configPath);
  const server = new McpServer({ name: "spend-gate-mcp-server", version: "0.1.0" });

  server.registerTool(
    "spend_gate_preview",
    {
      title: "Preview a spend decision",
      description:
        "Check a paid call against the local budget, per-call ceiling, hostname allowlist, and human threshold. Writes nothing and reserves nothing. Call this before spend_gate_decide when you only want the answer. A result of sign means a later decide would reserve the amount. This server never signs.",
      inputSchema: CallFields,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const decision = await evaluate({
          policy,
          input: challengeInput(args),
          resource: args.resource,
          idempotencyKey: args.idempotency_key,
          acceptIndex: args.accept_index,
        });
        return toolResult(decision);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "spend_gate_decide",
    {
      title: "Decide and reserve a spend",
      description:
        "Decide a paid call before any signature. sign reserves the amount until record or expiry. refuse reserves nothing. ask_human reserves nothing and waits for spend_gate_approve. already_recorded means this idempotency key was paid already; do not sign again. This server never signs and never moves value. Sign with your own wallet only after action is sign, then call spend_gate_record.",
      inputSchema: CallFields,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const decision = await decide({
          policy,
          input: challengeInput(args),
          resource: args.resource,
          idempotencyKey: args.idempotency_key,
          acceptIndex: args.accept_index,
        });
        return toolResult(decision);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "spend_gate_record",
    {
      title: "Record what happened after a decision",
      description:
        "Append a receipt for a key that spend_gate_decide or spend_gate_approve reserved. settlement signed or simulated counts against the budget. settlement unsent releases the reservation and spends nothing. fulfilment rejected sets refund to not_refunded: the receipt stays, and this tool does not reverse a payment. The reference is stored as the caller's attestation. It is not verified on a chain.",
      inputSchema: {
        idempotency_key: z.string().describe("Key returned by spend_gate_decide or spend_gate_approve."),
        fulfilment: z.enum(["accepted", "rejected", "unknown"]).optional().describe("Whether the paid result was usable."),
        fulfillment: z.enum(["accepted", "rejected", "unknown"]).optional().describe("Alias of fulfilment."),
        settlement: z.enum(["signed", "simulated", "unsent"]).describe("signed: caller attests a payment. simulated: local stand-in that still spends budget. unsent: nothing was paid."),
        reference: z.string().max(200).optional().describe("Caller-supplied id, such as a transaction id. Stored, not verified."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const decision = await record({
          policy,
          idempotencyKey: args.idempotency_key,
          fulfilment: fulfilmentOf(args),
          settlement: args.settlement as Settlement,
          reference: args.reference ?? null,
        });
        return toolResult(decision);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "spend_gate_approve",
    {
      title: "Approve a call that asked for a person",
      description:
        "Turn an ask_human decision into a reservation when a person has agreed. Re-checks the host, ceiling, and remaining budget. Does not sign.",
      inputSchema: {
        idempotency_key: z.string().describe("Key of a pending ask_human decision."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return toolResult(await approve({ policy, idempotencyKey: args.idempotency_key }));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "spend_gate_deny",
    {
      title: "Deny a call that asked for a person",
      description: "Refuse a pending ask_human decision. Nothing is reserved and the key stays denied.",
      inputSchema: {
        idempotency_key: z.string().describe("Key of a pending ask_human decision."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return toolResult(await deny({ policy, idempotencyKey: args.idempotency_key }));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "spend_gate_ledger",
    {
      title: "Read the spend ledger",
      description:
        "Show budget, spent, reserved, and remaining, plus recent decisions. Expired reservations are not counted. This does not write and does not sign.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const summary = await summarize(policy);
        return {
          content: [{ type: "text" as const, text: formatLedger(summary) }],
          structuredContent: asRecord(summary),
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "spend_gate_probe",
    {
      title: "Fetch a URL and decide its payment challenge",
      description:
        "GET one URL, read an x402 402 challenge or PAYMENT-REQUIRED header, and run it through the policy. Sends no payment header and does not follow redirects. reserve=false (default) only previews. reserve=true persists a reservation when the action is sign. Never signs.",
      inputSchema: {
        url: z.string().describe("http(s) URL to fetch."),
        reserve: z.boolean().optional().describe("Persist a reservation when the decision is sign. Default false."),
        idempotency_key: z.string().optional().describe("Key to use when reserve is true."),
        accept_index: z.number().int().min(0).optional().describe("Which exact option to judge."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const hit = await probe(args.url);
        if (hit.kind !== "challenge") {
          const text = hit.kind === "redirect"
            ? `HTTP ${hit.status} redirect to ${hit.location ?? "(no location)"}. Not followed. No payment was sent.`
            : `HTTP ${hit.status} from ${hit.url} did not ask for payment. ${hit.snippet}`;
          return { content: [{ type: "text" as const, text }], structuredContent: asRecord({ probe: hit }) };
        }
        const decision = args.reserve
          ? await decide({ policy, input: hit.challenge, resource: hit.url, idempotencyKey: args.idempotency_key, acceptIndex: args.accept_index })
          : await evaluate({ policy, input: hit.challenge, resource: hit.url, idempotencyKey: args.idempotency_key, acceptIndex: args.accept_index });
        return {
          content: [{ type: "text" as const, text: `HTTP ${hit.status} ${hit.url}\n${formatDecision(decision)}` }],
          structuredContent: asRecord({ probe: { kind: hit.kind, status: hit.status, url: hit.url }, decision }),
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath(process.env.SPEND_GATE_CONFIG);
  const server = createServer(configPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
