import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("an agent can decide and record through the MCP server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-gate-mcp-"));
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
    }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.SPEND_GATE_CONFIG = configPath;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp.ts"],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "spend-gate-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of [
      "spend_gate_preview",
      "spend_gate_decide",
      "spend_gate_approve",
      "spend_gate_deny",
      "spend_gate_record",
      "spend_gate_ledger",
      "spend_gate_probe",
    ]) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }

    const decided = await client.callTool({
      name: "spend_gate_decide",
      arguments: {
        resource: "https://merchant.example/search",
        amount: "10000",
        network: "eip155:84532",
        asset: "token-usdc-test",
        pay_to: "payee-test",
        idempotency_key: "mcp-1",
      },
    });
    const decidedText = JSON.stringify(decided);
    assert.match(decidedText, /SIGN/);
    assert.match(decidedText, /valueMovedByThisTool":false/);

    const recorded = await client.callTool({
      name: "spend_gate_record",
      arguments: {
        idempotency_key: "mcp-1",
        fulfilment: "rejected",
        settlement: "simulated",
        reference: "local-mcp",
      },
    });
    assert.match(JSON.stringify(recorded), /not_refunded/);
  } finally {
    await client.close();
  }
});
