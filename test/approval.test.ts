import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function setup(): { configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-gate-appr-"));
  const configPath = path.join(dir, "spend-gate.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      budgetAtomic: "100000",
      ceilingAtomic: "80000",
      humanThresholdAtomic: "20000",
      decimals: 6,
      symbol: "USDC",
      allowHosts: ["merchant.example"],
      networks: ["eip155:84532"],
      assets: [],
      allowPayTo: [],
      reservationTtlSeconds: 120,
      ledgerPath: "ledger.jsonl",
    }),
  );
  return { configPath };
}

function cli(configPath: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--config", configPath], {
    cwd: root,
    encoding: "utf8",
  });
}

async function connect(configPath: string, extra: Record<string, string> = {}): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, { SPEND_GATE_CONFIG: configPath }, extra);
  const client = new Client({ name: "spend-gate-test", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp.ts"], cwd: root, env, stderr: "pipe" }));
  return client;
}

const big = {
  resource: "https://merchant.example/report",
  amount: "50000",
  network: "eip155:84532",
  asset: "token-usdc-test",
  pay_to: "payee-test",
  idempotency_key: "big-1",
};

test("the MCP server does not let the agent approve or deny its own spend", async () => {
  const { configPath } = setup();
  const client = await connect(configPath);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("spend_gate_approve"));
    assert.ok(!names.includes("spend_gate_deny"));

    const asked = JSON.stringify(await client.callTool({ name: "spend_gate_decide", arguments: big }));
    assert.match(asked, /ASK A PERSON/);
    assert.match(asked, /spend-gate approve big-1/);
    assert.match(asked, /cannot approve it yourself/);

    const forged = await client.callTool({ name: "spend_gate_approve", arguments: { idempotency_key: "big-1" } });
    assert.equal(forged.isError, true);

    // Still waiting: the agent got nothing reserved.
    const still = JSON.stringify(await client.callTool({ name: "spend_gate_decide", arguments: big }));
    assert.match(still, /ASK A PERSON/);

    // A person approves from a separate process; the same key now reserves.
    const approved = cli(configPath, "approve", "big-1");
    assert.equal(approved.status, 0, approved.stderr);
    const after = JSON.stringify(await client.callTool({ name: "spend_gate_decide", arguments: big }));
    assert.match(after, /SIGN/);

    const receipt = JSON.stringify(await client.callTool({ name: "spend_gate_receipt", arguments: { idempotency_key: "big-1" } }));
    assert.match(receipt, /RECEIPT big-1/);
    assert.match(receipt, /Approved and reserved/);
  } finally {
    await client.close();
  }
});

test("agent approval tools exist only when the operator opts in", async () => {
  const { configPath } = setup();
  const client = await connect(configPath, { SPEND_GATE_ALLOW_AGENT_APPROVAL: "1" });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("spend_gate_approve"));
    assert.ok(names.includes("spend_gate_deny"));
  } finally {
    await client.close();
  }
});

test("pending lists waiting calls and receipt reads like a receipt", () => {
  const { configPath } = setup();
  assert.match(cli(configPath, "pending").stdout, /Nothing is waiting/);

  const decided = cli(configPath, "decide", "--resource", big.resource, "--amount", big.amount, "--network", big.network, "--asset", big.asset, "--pay-to", big.pay_to, "--idempotency-key", "big-1");
  assert.equal(decided.status, 3);

  const pending = cli(configPath, "pending");
  assert.equal(pending.status, 3);
  assert.match(pending.stdout, /spend-gate approve big-1/);

  assert.equal(cli(configPath, "approve", "big-1").status, 0);
  assert.equal(cli(configPath, "record", "big-1", "--fulfilment", "rejected", "--settlement", "simulated", "--reference", "local-1").status, 0);
  const receipt = cli(configPath, "receipt", "big-1").stdout;
  assert.match(receipt, /RECEIPT big-1/);
  assert.match(receipt, /0\.05 USDC/);
  assert.match(receipt, /NOT refunded/);
  assert.match(receipt, /not verified/);

  assert.notEqual(cli(configPath, "receipt", "nope").status, 0);
});
