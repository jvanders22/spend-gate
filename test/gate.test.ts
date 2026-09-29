import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GateError } from "../src/errors.ts";
import { approve, decide, deny, evaluate, record, summarize } from "../src/gate.ts";
import { parseChallenge } from "../src/parse.ts";
import { loadPolicy, writeDefaultConfig, type Policy } from "../src/policy.ts";
import { probe } from "../src/probe.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempPolicy(overrides: Record<string, unknown> = {}): Policy {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-gate-"));
  const configPath = path.join(dir, "spend-gate.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      budgetAtomic: "50000",
      ceilingAtomic: "30000",
      humanThresholdAtomic: "20000",
      decimals: 6,
      symbol: "USDC",
      allowHosts: ["merchant.example"],
      networks: ["eip155:84532"],
      assets: [],
      allowPayTo: [],
      reservationTtlSeconds: 120,
      ledgerPath: "ledger.jsonl",
      ...overrides,
    }),
  );
  return loadPolicy(configPath);
}

function call(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "token-usdc-test",
    payTo: "payee-test",
    maxTimeoutSeconds: 60,
    resource: "https://merchant.example/search?q=1",
    ...overrides,
  };
}

test("parses an x402 v2 document, a v1 amount, and a base64 header", () => {
  const v2 = {
    x402Version: 2,
    resource: { url: "https://merchant.example/search" },
    accepts: [
      { scheme: "exact", network: "eip155:8453", amount: "90000", asset: "main", payTo: "payee-main", maxTimeoutSeconds: 30 },
      { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "token-usdc-test", payTo: "payee-test", maxTimeoutSeconds: 30 },
    ],
  };
  const parsed = parseChallenge(v2, { networks: ["eip155:84532"] });
  assert.equal(parsed.amount, "10000");
  assert.equal(parsed.network, "eip155:84532");
  assert.equal(parsed.host, "merchant.example");

  const v1 = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        maxAmountRequired: "25000",
        resource: "https://merchant.example/v1",
        asset: "token-usdc-test",
        payTo: "payee-test",
      },
    ],
  };
  assert.equal(parseChallenge(v1).amount, "25000");
  const encoded = Buffer.from(JSON.stringify(v2)).toString("base64");
  assert.equal(parseChallenge(encoded, { networks: ["eip155:84532"] }).resource, "https://merchant.example/search");
});

test("refuses to guess when the quoted URL and the requested URL differ", () => {
  assert.throws(
    () => parseChallenge(call(), { resource: "https://merchant.example/other" }),
    (err: unknown) => err instanceof GateError && err.message.includes("does not match"),
  );
});

test("refuses a decimal amount instead of treating it as atomic units", () => {
  assert.throws(
    () => parseChallenge(call({ amount: "0.01" })),
    (err: unknown) => err instanceof GateError && err.message.includes("atomic"),
  );
});

test("signs inside policy, refuses an unknown host before reserving, and refuses the ceiling", async () => {
  const policy = tempPolicy();
  const signed = await decide({ policy, input: call(), idempotencyKey: "ok-1" });
  assert.equal(signed.action, "sign");
  assert.equal(signed.persisted, true);
  assert.equal(signed.reservedAtomic, "10000");
  assert.equal(signed.valueMovedByThisTool, false);

  const off = await decide({ policy, input: call({ resource: "https://other.example/x" }), idempotencyKey: "off-1" });
  assert.equal(off.action, "refuse");
  assert.match(off.reason, /not on the allowlist/);
  assert.equal(off.reservedAtomic, "10000");

  const high = await decide({ policy, input: call({ amount: "30001", resource: "https://merchant.example/high" }), idempotencyKey: "high-1" });
  assert.equal(high.action, "refuse");
  assert.match(high.reason, /ceiling/);
  const book = await summarize(policy);
  assert.equal(book.spentAtomic, "0");
  assert.equal(book.reservedAtomic, "10000");
});

test("a repeated key reserves once", async () => {
  const policy = tempPolicy();
  const first = await decide({ policy, input: call(), idempotencyKey: "same" });
  const second = await decide({ policy, input: call(), idempotencyKey: "same" });
  assert.equal(first.action, "sign");
  assert.equal(second.action, "sign");
  assert.equal(second.reservationExpiresAt, first.reservationExpiresAt);
  const book = await summarize(policy);
  assert.equal(book.reservedAtomic, "10000");
});

test("stops at the budget with the remainder unspent", async () => {
  const policy = tempPolicy({ ceilingAtomic: "50000", humanThresholdAtomic: "50000" });
  const now = new Date("2026-09-29T12:00:00.000Z");
  const a = await decide({ policy, input: call({ amount: "20000" }), idempotencyKey: "a", now });
  const b = await decide({ policy, input: call({ amount: "20000", resource: "https://merchant.example/b" }), idempotencyKey: "b", now });
  const c = await decide({ policy, input: call({ amount: "20000", resource: "https://merchant.example/c" }), idempotencyKey: "c", now });
  assert.equal(a.action, "sign");
  assert.equal(b.action, "sign");
  assert.equal(c.action, "refuse");
  assert.match(c.reason, /remaining budget/);
  assert.equal(c.remainingAtomic, "10000");
  assert.equal(c.spentAtomic, "0");
});

test("asks a person, then approve reserves and deny sticks", async () => {
  const policy = tempPolicy();
  const pending = await decide({
    policy,
    input: call({ amount: "25000", resource: "https://merchant.example/big" }),
    idempotencyKey: "needs-human",
  });
  assert.equal(pending.action, "ask_human");
  assert.equal(pending.reservedAtomic, "0");
  const approved = await approve({ policy, idempotencyKey: "needs-human" });
  assert.equal(approved.action, "sign");
  assert.match(approved.reason, /person approved/);
  assert.equal(approved.reservedAtomic, "25000");

  const other = tempPolicy();
  await decide({ policy: other, input: call({ amount: "25000" }), idempotencyKey: "nope" });
  const denied = await deny({ policy: other, idempotencyKey: "nope" });
  assert.equal(denied.action, "refuse");
  const again = await decide({ policy: other, input: call({ amount: "25000" }), idempotencyKey: "nope" });
  assert.equal(again.action, "refuse");
  assert.match(again.reason, /denied/);
  assert.equal((await summarize(other)).reservedAtomic, "0");
});

test("a rejected result stays on the ledger as not refunded", async () => {
  const policy = tempPolicy();
  const decision = await decide({ policy, input: call(), idempotencyKey: "junk" });
  const receipt = await record({
    policy,
    idempotencyKey: decision.idempotencyKey,
    fulfilment: "rejected",
    settlement: "simulated",
    reference: "local-1",
  });
  assert.equal(receipt.action, "already_recorded");
  assert.equal(receipt.receipt?.refund, "not_refunded");
  assert.equal(receipt.receipt?.attested, true);
  assert.equal(receipt.spentAtomic, "10000");
  const duplicate = await record({
    policy,
    idempotencyKey: "junk",
    fulfilment: "rejected",
    settlement: "simulated",
    reference: "local-1",
  });
  assert.equal(duplicate.action, "already_recorded");
  await assert.rejects(
    record({ policy, idempotencyKey: "junk", fulfilment: "accepted", settlement: "simulated", reference: "local-1" }),
    /already has a receipt/,
  );
});

test("unsent releases the reservation and an expired hold returns the budget", async () => {
  const policy = tempPolicy({ reservationTtlSeconds: 30 });
  const start = new Date("2026-09-29T12:00:00.000Z");
  await decide({ policy, input: call(), idempotencyKey: "hold", now: start });
  const released = await record({
    policy,
    idempotencyKey: "hold",
    fulfilment: "unknown",
    settlement: "unsent",
    now: start,
  });
  assert.equal(released.action, "released");
  assert.equal(released.spentAtomic, "0");
  assert.equal(released.reservedAtomic, "0");

  const laterPolicy = tempPolicy({
    reservationTtlSeconds: 30,
    ceilingAtomic: "50000",
    humanThresholdAtomic: "50000",
  });
  await decide({ policy: laterPolicy, input: call({ amount: "50000" }), idempotencyKey: "full", now: start });
  const after = new Date(start.getTime() + 31_000);
  const view = await summarize(laterPolicy, after);
  assert.equal(view.reservedAtomic, "0");
  assert.equal(view.remainingAtomic, "50000");
  const again = await decide({
    policy: laterPolicy,
    input: call({ amount: "50000", resource: "https://merchant.example/again" }),
    idempotencyKey: "full-2",
    now: after,
  });
  assert.equal(again.action, "sign");
});

test("two concurrent decisions cannot both spend the last unit of budget", async () => {
  const policy = tempPolicy({ budgetAtomic: "10000", ceilingAtomic: "10000", humanThresholdAtomic: "10000" });
  const [left, right] = await Promise.all([
    decide({ policy, input: call({ amount: "10000" }), idempotencyKey: "left" }),
    decide({
      policy,
      input: call({ amount: "10000", resource: "https://merchant.example/right" }),
      idempotencyKey: "right",
    }),
  ]);
  assert.deepEqual([left.action, right.action].sort(), ["refuse", "sign"]);
  assert.equal((await summarize(policy)).reservedAtomic, "10000");
});

test("preview does not reserve, and an empty allowlist refuses every host", async () => {
  const policy = tempPolicy();
  const preview = await evaluate({ policy, input: call(), idempotencyKey: "preview-1" });
  assert.equal(preview.action, "sign");
  assert.equal(preview.persisted, false);
  assert.equal((await summarize(policy)).counts.reserved, 0);

  const closed = tempPolicy({ allowHosts: [] });
  const refused = await decide({ policy: closed, input: call(), idempotencyKey: "closed" });
  assert.equal(refused.action, "refuse");
  assert.match(refused.reason, /allowHosts is empty/);
});

test("a torn final ledger line is ignored and a broken middle line is not", async () => {
  const policy = tempPolicy();
  await decide({ policy, input: call(), idempotencyKey: "kept" });
  fs.appendFileSync(policy.ledgerPath, "{\"v\":1,\"type\":\"refusal\"");
  const view = await summarize(policy);
  assert.equal(view.counts.reserved, 1);
  assert.ok(view.warnings.some((warning) => warning.includes("partial")));

  const broken = tempPolicy();
  await decide({ policy: broken, input: call(), idempotencyKey: "row" });
  const text = fs.readFileSync(broken.ledgerPath, "utf8");
  fs.writeFileSync(broken.ledgerPath, `{not json}\n${text}`);
  await assert.rejects(summarize(broken), /not valid JSON/);
});

test("the CLI refuses an off-list host and records a rejected receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-gate-cli-"));
  const config = path.join(dir, "spend-gate.json");
  writeDefaultConfig(config);
  const policyFile = JSON.parse(fs.readFileSync(config, "utf8")) as { allowHosts: string[] };
  policyFile.allowHosts = ["merchant.example"];
  fs.writeFileSync(config, JSON.stringify(policyFile));
  const base = ["--import", "tsx", "src/cli.ts", "--config", config, "--json"];
  const run = (args: string[]) =>
    spawnSync(process.execPath, [...base, ...args], { cwd: root, encoding: "utf8" });

  const off = run([
    "decide",
    "--resource",
    "https://other.example/item",
    "--amount",
    "10000",
    "--network",
    "eip155:84532",
    "--asset",
    "token-usdc-test",
    "--pay-to",
    "payee-test",
    "--idempotency-key",
    "cli-off",
  ]);
  assert.equal(off.status, 2, off.stderr);
  assert.equal(JSON.parse(off.stdout).action, "refuse");

  const signed = run([
    "decide",
    "--resource",
    "https://merchant.example/item",
    "--amount",
    "10000",
    "--network",
    "eip155:84532",
    "--asset",
    "token-usdc-test",
    "--pay-to",
    "payee-test",
    "--idempotency-key",
    "cli-ok",
  ]);
  assert.equal(signed.status, 0, signed.stderr);
  const recorded = run([
    "record",
    "cli-ok",
    "--fulfillment",
    "rejected",
    "--settlement",
    "simulated",
  ]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const body = JSON.parse(recorded.stdout) as { receipt: { refund: string }; spentAtomic: string };
  assert.equal(body.receipt.refund, "not_refunded");
  assert.equal(body.spentAtomic, "10000");
});

test("probe reads a local 402 and does not follow a redirect", async () => {
  const policy = tempPolicy();
  const server = http.createServer((req, res) => {
    if (req.url === "/paid") {
      const resource = `http://${req.headers.host}/paid`;
      const quoted = {
        x402Version: 2,
        resource,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            amount: "10000",
            asset: "token-usdc-test",
            payTo: "payee-test",
            maxTimeoutSeconds: 60,
          },
        ],
      };
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(quoted)).toString("base64"),
      });
      res.end("{}");
      return;
    }
    if (req.url === "/next") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("should not be fetched");
      return;
    }
    res.writeHead(302, { location: "/next" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const hit = await probe(`http://127.0.0.1:${port}/paid`);
    assert.equal(hit.kind, "challenge");
    if (hit.kind !== "challenge") return;
    const decision = await evaluate({ policy, input: hit.challenge, resource: `http://127.0.0.1:${port}/paid` });
    assert.equal(decision.action, "refuse");
    assert.match(decision.reason, /not on the allowlist/);
    const redirect = await probe(`http://127.0.0.1:${port}/away`);
    assert.equal(redirect.kind, "redirect");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
