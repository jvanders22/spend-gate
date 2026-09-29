import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GateError } from "./errors.js";
import { hostRuleValid } from "./host.js";
import { canonicalAtomic } from "./money.js";

export interface Policy {
  budgetAtomic: string;
  ceilingAtomic: string;
  humanThresholdAtomic: string;
  decimals: number;
  symbol: string;
  allowHosts: string[];
  networks: string[];
  assets: string[];
  allowPayTo: string[];
  reservationTtlSeconds: number;
  ledgerPath: string;
  configPath: string;
}

export interface PolicyFile {
  budgetAtomic: string;
  ceilingAtomic: string;
  humanThresholdAtomic: string;
  decimals: number;
  symbol: string;
  allowHosts: string[];
  networks: string[];
  assets: string[];
  allowPayTo: string[];
  reservationTtlSeconds: number;
  ledgerPath: string;
}

export const DEFAULT_POLICY_FILE: PolicyFile = {
  budgetAtomic: "1000000",
  ceilingAtomic: "100000",
  humanThresholdAtomic: "50000",
  decimals: 6,
  symbol: "USDC",
  allowHosts: [],
  networks: [],
  assets: [],
  allowPayTo: [],
  reservationTtlSeconds: 120,
  ledgerPath: "ledger.jsonl",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function atomicField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value === "number") {
    throw new GateError(
      "invalid_config",
      `${key} is a JSON number. Write it as a string of atomic units so large amounts are not rounded.`,
    );
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new GateError(
      "invalid_config",
      `${key} must be a string of atomic units, for example "10000".`,
    );
  }
  return canonicalAtomic(value);
}

function stringList(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new GateError("invalid_config", `${key} must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function integerField(obj: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new GateError("invalid_config", `${key} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function policyFromUnknown(raw: unknown, configPath: string): Policy {
  if (!isRecord(raw)) throw new GateError("invalid_config", "Config must be a JSON object.");
  const budgetAtomic = atomicField(raw, "budgetAtomic");
  const ceilingAtomic = atomicField(raw, "ceilingAtomic");
  const humanThresholdAtomic = atomicField(raw, "humanThresholdAtomic");
  if (BigInt(ceilingAtomic) > BigInt(budgetAtomic)) {
    throw new GateError("invalid_config", "ceilingAtomic cannot be greater than budgetAtomic.");
  }
  if (BigInt(humanThresholdAtomic) > BigInt(ceilingAtomic)) {
    throw new GateError(
      "invalid_config",
      "humanThresholdAtomic cannot be greater than ceilingAtomic. Calls above the ceiling are refused before a person is asked.",
    );
  }
  const decimals = integerField(raw, "decimals", 6, 0, 18);
  const symbolValue = raw.symbol === undefined ? "USDC" : raw.symbol;
  if (typeof symbolValue !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(symbolValue)) {
    throw new GateError("invalid_config", 'symbol must be 1 to 12 letters or digits, for example "USDC".');
  }
  const allowHosts = stringList(raw, "allowHosts").map((host) => host.toLowerCase());
  for (const rule of allowHosts) {
    if (!hostRuleValid(rule)) {
      throw new GateError(
        "invalid_config",
        `allowHosts entry ${JSON.stringify(rule)} is not a hostname, *.hostname, or *.`,
      );
    }
  }
  const ledgerRel = raw.ledgerPath === undefined ? "ledger.jsonl" : raw.ledgerPath;
  if (typeof ledgerRel !== "string" || ledgerRel.trim().length === 0 || ledgerRel.includes("\0")) {
    throw new GateError("invalid_config", "ledgerPath must be a file path.");
  }
  return {
    budgetAtomic,
    ceilingAtomic,
    humanThresholdAtomic,
    decimals,
    symbol: symbolValue,
    allowHosts,
    networks: stringList(raw, "networks"),
    assets: stringList(raw, "assets"),
    allowPayTo: stringList(raw, "allowPayTo"),
    reservationTtlSeconds: integerField(raw, "reservationTtlSeconds", 120, 1, 86_400),
    ledgerPath: path.resolve(path.dirname(configPath), ledgerRel),
    configPath,
  };
}

export function loadPolicy(configPath: string): Policy {
  const abs = path.resolve(configPath);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GateError(
        "invalid_config",
        `No config at ${abs}. Run spend-gate init, or set SPEND_GATE_CONFIG to a config file.`,
      );
    }
    throw new GateError("invalid_config", `Could not read ${abs}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new GateError("invalid_config", `Config ${abs} is not JSON: ${(err as Error).message}`);
  }
  return policyFromUnknown(raw, abs);
}

export function resolveConfigPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.SPEND_GATE_CONFIG) return path.resolve(process.env.SPEND_GATE_CONFIG);
  const local = path.resolve("spend-gate.json");
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), ".config", "spend-gate", "spend-gate.json");
}

export function writeDefaultConfig(file: string): void {
  const abs = path.resolve(file);
  if (fs.existsSync(abs)) {
    throw new GateError("invalid_config", `${abs} already exists. spend-gate init will not overwrite it.`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(DEFAULT_POLICY_FILE, null, 2)}\n`);
}
