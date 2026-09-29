import fs from "node:fs";
import path from "node:path";
import { GateError } from "./errors.js";
import type { Fulfilment, LedgerLine, Refund, ReleaseReason, Settlement, StoredCall } from "./types.js";

export type Phase = "refused" | "pending_human" | "reserved" | "released" | "denied" | "recorded";

export interface KeyState {
  idempotencyKey: string;
  phase: Phase;
  call: StoredCall;
  reason: string;
  at: string;
  expiresAt?: string;
  settlement?: Settlement;
  fulfilment?: Fulfilment;
  refund?: Refund;
  reference?: string | null;
  recordedAt?: string;
}

export interface Book {
  keys: Map<string, KeyState>;
  warnings: string[];
}

export interface LoadedLedger {
  lines: LedgerLine[];
  warnings: string[];
}

const RELEASE_REASONS = new Set<ReleaseReason>(["expired", "denied", "unsent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLine(value: unknown, where: string): LedgerLine {
  if (!isRecord(value) || value.v !== 1 || typeof value.type !== "string") {
    throw new GateError("invalid_ledger", `${where} is not a spend-gate ledger line.`);
  }
  return value as unknown as LedgerLine;
}

export async function readLedger(ledgerPath: string): Promise<LoadedLedger> {
  let text: string;
  try {
    text = await fs.promises.readFile(ledgerPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], warnings: [] };
    throw new GateError("invalid_ledger", `Could not read ${ledgerPath}: ${(err as Error).message}`);
  }
  if (text.length === 0) return { lines: [], warnings: [] };
  const rows = text.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  const lines: LedgerLine[] = [];
  const warnings: string[] = [];
  rows.forEach((row, index) => {
    if (row.length === 0) return;
    try {
      lines.push(asLine(JSON.parse(row) as unknown, `${ledgerPath}:${index + 1}`));
    } catch (err) {
      const last = index === rows.length - 1;
      if (last && !(err instanceof GateError)) {
        warnings.push(`Ignored a partial final line in ${ledgerPath}. The previous receipts are intact.`);
        return;
      }
      if (err instanceof GateError) throw err;
      throw new GateError(
        "invalid_ledger",
        `Ledger ${ledgerPath} line ${index + 1} is not valid JSON. spend-gate will not guess past it.`,
      );
    }
  });
  return { lines, warnings };
}

function base(line: { idempotencyKey: string; at: string; call: StoredCall; reason: string }): KeyState {
  return {
    idempotencyKey: line.idempotencyKey,
    phase: "refused",
    call: line.call,
    reason: line.reason,
    at: line.at,
  };
}

export function fold(lines: LedgerLine[]): Book {
  const keys = new Map<string, KeyState>();
  const warnings: string[] = [];
  for (const line of lines) {
    if (!line || line.v !== 1) {
      warnings.push("Skipped a ledger line with an unsupported version.");
      continue;
    }
    const current = keys.get(line.idempotencyKey);
    switch (line.type) {
      case "refusal":
        // A later refusal may replace a pending ask: the person approved, then the
        // budget or the host check failed and the call must not stay open.
        if (current && ["reserved", "recorded", "denied"].includes(current.phase)) {
          warnings.push(`Ignored a refusal for ${line.idempotencyKey} because that key is ${current.phase}.`);
          break;
        }
        keys.set(line.idempotencyKey, { ...base(line), phase: "refused" });
        break;
      case "pending_human":
        if (current && (current.phase === "recorded" || current.phase === "denied")) {
          warnings.push(`Ignored pending_human for ${line.idempotencyKey} because that key is ${current.phase}.`);
          break;
        }
        keys.set(line.idempotencyKey, { ...base(line), phase: "pending_human" });
        break;
      case "reservation":
        if (current?.phase === "recorded") {
          warnings.push(`Ignored a reservation for ${line.idempotencyKey} because a receipt already exists.`);
          break;
        }
        if (current?.phase === "reserved") {
          warnings.push(`Ignored a duplicate reservation for ${line.idempotencyKey}.`);
          break;
        }
        keys.set(line.idempotencyKey, { ...base(line), phase: "reserved", expiresAt: line.expiresAt });
        break;
      case "release":
        if (!current || current.phase !== "reserved") {
          warnings.push(`Ignored a release for ${line.idempotencyKey} because there is no open reservation.`);
          break;
        }
        if (!RELEASE_REASONS.has(line.reason)) {
          warnings.push(`Ignored a release for ${line.idempotencyKey} with an unknown reason.`);
          break;
        }
        current.phase = "released";
        current.reason = line.reason === "expired" ? "The reservation expired before a receipt was written." : current.reason;
        current.expiresAt = undefined;
        if (line.reason === "unsent") {
          current.settlement = "unsent";
          current.refund = "not_applicable";
          current.recordedAt = line.at;
        }
        break;
      case "denied":
        if (!current || current.phase !== "pending_human") {
          warnings.push(`Ignored a denial for ${line.idempotencyKey} because that call is not waiting for a person.`);
          break;
        }
        current.phase = "denied";
        current.reason = line.reason;
        current.at = line.at;
        break;
      case "receipt":
        if (!current || current.phase !== "reserved") {
          warnings.push(`Ignored a receipt for ${line.idempotencyKey} because there is no open reservation.`);
          break;
        }
        current.settlement = line.settlement;
        current.fulfilment = line.fulfilment;
        current.refund = line.settlement === "unsent" ? "not_applicable" : line.refund;
        current.reference = line.reference;
        current.recordedAt = line.at;
        current.reason = line.reason;
        current.phase = line.settlement === "unsent" ? "released" : "recorded";
        if (line.settlement === "unsent") current.expiresAt = undefined;
        break;
      default:
        warnings.push("Skipped a ledger line with an unknown type.");
    }
  }
  return { keys, warnings };
}

export function expiryLines(lines: LedgerLine[], now: Date): LedgerLine[] {
  const book = fold(lines);
  const out: LedgerLine[] = [];
  for (const state of book.keys.values()) {
    if (state.phase === "reserved" && state.expiresAt && Date.parse(state.expiresAt) <= now.getTime()) {
      out.push({
        v: 1,
        type: "release",
        at: now.toISOString(),
        idempotencyKey: state.idempotencyKey,
        reason: "expired",
      });
    }
  }
  return out;
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  const pidFile = path.join(lockPath, "pid");
  try {
    const pid = Number((await fs.promises.readFile(pidFile, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "EPERM";
      }
    }
  } catch {
    // A lock directory without a readable pid is stale once it has sat there.
  }
  try {
    const stat = await fs.promises.stat(lockPath);
    return Date.now() - stat.mtimeMs > 10_000;
  } catch {
    return true;
  }
}

async function acquire(lockPath: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await fs.promises.mkdir(lockPath);
      try {
        await fs.promises.writeFile(path.join(lockPath, "pid"), `${process.pid}\n`);
      } catch (err) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        throw err;
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await lockIsStale(lockPath)) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 5_000) {
        throw new GateError(
          "lock_timeout",
          `Timed out waiting for ${lockPath}. Another spend-gate process is writing the ledger. If that process is gone, remove the lock directory and retry.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function updateLedger<T>(
  ledgerPath: string,
  fn: (loaded: LoadedLedger) => { append: LedgerLine[]; value: T } | Promise<{ append: LedgerLine[]; value: T }>,
): Promise<T> {
  await fs.promises.mkdir(path.dirname(ledgerPath), { recursive: true });
  const lockPath = `${ledgerPath}.lock`;
  await acquire(lockPath);
  try {
    const loaded = await readLedger(ledgerPath);
    const result = await fn(loaded);
    if (result.append.length > 0) {
      const payload = result.append.map((line) => JSON.stringify(line)).join("\n") + "\n";
      await fs.promises.appendFile(ledgerPath, payload, "utf8");
    }
    return result.value;
  } finally {
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}
