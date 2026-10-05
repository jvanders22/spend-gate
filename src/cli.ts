#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { GateError } from "./errors.js";
import { formatDecision, formatLedger } from "./format.js";
import { approve, decide, deny, evaluate, exitCode, expireReservations, record, summarize } from "./gate.js";
import { loadPolicy, resolveConfigPath, writeDefaultConfig } from "./policy.js";
import { probe } from "./probe.js";
import type { Decision, Fulfilment, Settlement } from "./types.js";

type Flags = Map<string, string | boolean>;

function parseArgs(argv: string[]): { command: string | undefined; position: string[]; flags: Flags } {
  const flags: Flags = new Map();
  const position: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--") {
      position.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      position.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    const booleanFlag = key === "json" || key === "help" || key === "reserve";
    if (booleanFlag || next === undefined || next.startsWith("--")) flags.set(key, true);
    else {
      flags.set(key, next);
      i += 1;
    }
  }
  return { command: position[0], position: position.slice(1), flags };
}

function flagString(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function challengeFrom(flags: Flags): unknown {
  const file = flagString(flags, "challenge");
  if (file) return file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  const resource = flagString(flags, "resource");
  const amount = flagString(flags, "amount");
  const network = flagString(flags, "network");
  const asset = flagString(flags, "asset");
  const payTo = flagString(flags, "pay-to") ?? flagString(flags, "payTo");
  if (!resource && !amount && !network && !asset && !payTo) {
    throw new GateError(
      "usage",
      "Pass --challenge <file> (or --challenge - for stdin), or --resource, --amount, --network, --asset, and --pay-to.",
    );
  }
  const missing = [
    ["resource", resource],
    ["amount", amount],
    ["network", network],
    ["asset", asset],
    ["pay-to", payTo],
  ]
    .filter((pair) => !pair[1])
    .map((pair) => pair[0]);
  if (missing.length > 0) {
    throw new GateError(
      "usage",
      `Missing ${missing.join(", ")}. A paid call needs a URL, an atomic amount, a network, an asset, and a payTo.`,
    );
  }
  const timeout = flagString(flags, "max-timeout-seconds");
  return {
    scheme: flagString(flags, "scheme") ?? "exact",
    network,
    amount,
    asset,
    payTo,
    resource,
    maxTimeoutSeconds: timeout ? Number(timeout) : undefined,
    description: flagString(flags, "description") ?? "",
  };
}

function printDecision(decision: Decision, asJson: boolean): void {
  process.stdout.write(asJson ? `${JSON.stringify(decision, null, 2)}\n` : `${formatDecision(decision)}\n`);
}

function help(): string {
  return `spend-gate — decide a paid call before anything is signed

Usage
  spend-gate init [--config file]
  spend-gate decide  --challenge <file|-> | (--resource --amount --network --asset --pay-to)
  spend-gate preview --challenge <file|-> | (--resource --amount --network --asset --pay-to)
  spend-gate approve <key>
  spend-gate deny <key>
  spend-gate record <key> --fulfilment accepted|rejected|unknown --settlement signed|simulated|unsent [--reference text]
  spend-gate ledger
  spend-gate expire
  spend-gate probe <url> [--reserve]

Options
  --config <file>          Policy file. Else SPEND_GATE_CONFIG, then ./spend-gate.json, then ~/.config/spend-gate/spend-gate.json
  --idempotency-key <key>  Reuse a key so a retry does not reserve twice
  --accept-index <n>       Pick the nth exact option in a challenge
  --json                   Print JSON
  --reserve                With probe, persist a reservation when the decision is sign

Exit codes
  0  sign, recorded, released, ledger, or a probe that got an HTTP answer
  2  refuse
  3  ask a person
  1  usage, a broken challenge, or a transport failure

spend-gate never signs, never broadcasts, and never moves value.
A rejected result is marked not_refunded. The receipt stays. This tool does not reverse the payment.
`;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const asJson = parsed.flags.get("json") === true;
  if (!parsed.command || parsed.command === "help" || parsed.flags.get("help") === true) {
    process.stdout.write(help());
    return;
  }

  if (parsed.command === "init") {
    const chosen = path.resolve(flagString(parsed.flags, "config") ?? "spend-gate.json");
    writeDefaultConfig(chosen);
    const policy = loadPolicy(chosen);
    const lines = [
      `Wrote ${policy.configPath}`,
      `Ledger will be ${policy.ledgerPath}`,
      `Budget ${policy.budgetAtomic} atomic, ceiling ${policy.ceilingAtomic}, human threshold ${policy.humanThresholdAtomic}.`,
      policy.allowHosts.length === 0
        ? "allowHosts is empty, so every call is refused until you add a merchant hostname."
        : `allowHosts ${policy.allowHosts.join(", ")}`,
      policy.networks.length === 0
        ? "networks is empty, so any network string is allowed. Pin the ones you accept."
        : `networks ${policy.networks.join(", ")}`,
      policy.assets.length === 0
        ? "assets is empty, so any asset string is allowed. Pin the token you accept."
        : `assets ${policy.assets.join(", ")}`,
      policy.allowPayTo.length === 0
        ? "allowPayTo is empty, so any payTo address is allowed. Pin the recipients you accept."
        : `allowPayTo ${policy.allowPayTo.join(", ")}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const policy = loadPolicy(resolveConfigPath(flagString(parsed.flags, "config")));
  const idempotencyKey = flagString(parsed.flags, "idempotency-key") ?? flagString(parsed.flags, "key");
  const acceptRaw = flagString(parsed.flags, "accept-index");
  const acceptIndex = acceptRaw === undefined ? undefined : Number(acceptRaw);
  if (acceptIndex !== undefined && (!Number.isInteger(acceptIndex) || acceptIndex < 0)) {
    throw new GateError("usage", "--accept-index must be an integer starting at 0.");
  }

  if (parsed.command === "ledger") {
    const summary = await summarize(policy);
    process.stdout.write(asJson ? `${JSON.stringify(summary, null, 2)}\n` : `${formatLedger(summary)}\n`);
    return;
  }
  if (parsed.command === "expire") {
    const summary = await expireReservations(policy);
    process.stdout.write(asJson ? `${JSON.stringify(summary, null, 2)}\n` : `${formatLedger(summary)}\n`);
    return;
  }
  if (parsed.command === "approve" || parsed.command === "deny") {
    const key = parsed.position[0] ?? idempotencyKey;
    if (!key) throw new GateError("usage", `spend-gate ${parsed.command} <key>`);
    const decision = parsed.command === "approve"
      ? await approve({ policy, idempotencyKey: key })
      : await deny({ policy, idempotencyKey: key });
    printDecision(decision, asJson);
    process.exitCode = exitCode(decision);
    return;
  }
  if (parsed.command === "record") {
    const key = parsed.position[0] ?? idempotencyKey;
    const fulfilment = (flagString(parsed.flags, "fulfilment") ?? flagString(parsed.flags, "fulfillment")) as Fulfilment | undefined;
    const settlement = flagString(parsed.flags, "settlement") as Settlement | undefined;
    if (!key || !fulfilment || !settlement) {
      throw new GateError(
        "usage",
        "spend-gate record <key> --fulfilment accepted|rejected|unknown --settlement signed|simulated|unsent",
      );
    }
    const decision = await record({
      policy,
      idempotencyKey: key,
      fulfilment,
      settlement,
      reference: flagString(parsed.flags, "reference") ?? null,
    });
    printDecision(decision, asJson);
    process.exitCode = exitCode(decision);
    return;
  }
  if (parsed.command === "decide" || parsed.command === "preview") {
    const decision = parsed.command === "decide"
      ? await decide({
          policy,
          input: challengeFrom(parsed.flags),
          resource: flagString(parsed.flags, "resource"),
          idempotencyKey,
          acceptIndex,
        })
      : await evaluate({
          policy,
          input: challengeFrom(parsed.flags),
          resource: flagString(parsed.flags, "resource"),
          idempotencyKey,
          acceptIndex,
        });
    printDecision(decision, asJson);
    process.exitCode = exitCode(decision);
    return;
  }
  if (parsed.command === "probe") {
    const url = parsed.position[0] ?? flagString(parsed.flags, "url");
    if (!url) throw new GateError("usage", "spend-gate probe <url>");
    const hit = await probe(url);
    if (hit.kind === "redirect") {
      const text = `HTTP ${hit.status} redirect to ${hit.location ?? "(no location)"}\nNo payment was sent, and the redirect was not followed.\n`;
      process.stdout.write(asJson ? `${JSON.stringify({ probe: hit }, null, 2)}\n` : text);
      return;
    }
    if (hit.kind === "no_payment") {
      const text = `HTTP ${hit.status} from ${hit.url} did not ask for payment.\n${hit.snippet}\n`;
      process.stdout.write(asJson ? `${JSON.stringify({ probe: hit }, null, 2)}\n` : text);
      return;
    }
    const reserve = parsed.flags.get("reserve") === true;
    const args = { policy, input: hit.challenge, resource: hit.url, idempotencyKey, acceptIndex };
    const decision = reserve ? await decide(args) : await evaluate(args);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ probe: { kind: hit.kind, status: hit.status, url: hit.url }, decision }, null, 2)}\n`);
    } else {
      process.stdout.write(`HTTP ${hit.status} ${hit.url}\n${formatDecision(decision)}\n`);
    }
    process.exitCode = exitCode(decision);
    return;
  }
  throw new GateError("usage", `Unknown command ${parsed.command}.\n\n${help()}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
