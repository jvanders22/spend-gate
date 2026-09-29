import { randomUUID } from "node:crypto";
import { GateError } from "./errors.js";
import { hostAllowed } from "./host.js";
import { expiryLines, fold, updateLedger, type Book, type KeyState } from "./ledger.js";
import { formatAmount, parseAtomic } from "./money.js";
import { parseChallenge, sameCall } from "./parse.js";
import type { Policy } from "./policy.js";
import type {
  Action,
  Decision,
  Fulfilment,
  LedgerEntry,
  LedgerLine,
  LedgerSummary,
  ReceiptView,
  Refund,
  Settlement,
  StoredCall,
} from "./types.js";

export interface DecideArgs {
  policy: Policy;
  input: unknown;
  resource?: string;
  idempotencyKey?: string;
  acceptIndex?: number;
  now?: Date;
}

export interface RecordArgs {
  policy: Policy;
  idempotencyKey: string;
  fulfilment: Fulfilment;
  settlement: Settlement;
  reference?: string | null;
  now?: Date;
}

export interface KeyArgs {
  policy: Policy;
  idempotencyKey: string;
  now?: Date;
}

interface Totals {
  spent: bigint;
  reserved: bigint;
  remaining: bigint;
  warnings: string[];
}

interface Judgment {
  action: "sign" | "refuse" | "ask_human";
  reason: string;
  expiresAt: string | null;
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function requireKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!KEY_PATTERN.test(key)) {
    throw new GateError(
      "usage",
      "idempotency key must be 1 to 200 characters of letters, digits, dot, underscore, colon, or hyphen.",
    );
  }
  return key;
}

function freshKey(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return `sg_${randomUUID()}`;
  return requireKey(trimmed);
}

export function totals(book: Book, policy: Policy, now: Date): Totals {
  let spent = 0n;
  let reserved = 0n;
  for (const state of book.keys.values()) {
    const amount = BigInt(state.call.amount);
    if (state.phase === "recorded" && (state.settlement === "signed" || state.settlement === "simulated")) {
      spent += amount;
    } else if (state.phase === "reserved" && state.expiresAt && Date.parse(state.expiresAt) > now.getTime()) {
      reserved += amount;
    }
  }
  const budget = BigInt(policy.budgetAtomic);
  const remaining = budget - spent - reserved;
  const warnings = [...book.warnings];
  if (remaining < 0n) {
    warnings.push("Ledger sums exceed the budget. New signatures are refused until the numbers fit.");
  }
  return { spent, reserved, remaining, warnings };
}

function listed(value: string, allowed: string[]): boolean {
  const needle = value.toLowerCase();
  return allowed.some((item) => item.toLowerCase() === needle);
}

function judge(call: StoredCall, policy: Policy, money: Totals, now: Date, humanApproved: boolean): Judgment {
  const amount = parseAtomic(call.amount, "amount");
  if (amount <= 0n) {
    return { action: "refuse", reason: "Amount must be a positive integer in atomic units. Nothing was reserved.", expiresAt: null };
  }
  if (call.scheme !== "exact") {
    return {
      action: "refuse",
      reason: `Scheme ${call.scheme} is not decided here. spend-gate prices the exact scheme only, because upto and batch are not a single atomic amount. Nothing was reserved.`,
      expiresAt: null,
    };
  }
  if (policy.networks.length > 0 && !policy.networks.includes(call.network)) {
    return {
      action: "refuse",
      reason: `Network ${call.network} is not in networks [${policy.networks.join(", ")}]. Nothing was reserved.`,
      expiresAt: null,
    };
  }
  if (policy.assets.length > 0 && !listed(call.asset, policy.assets)) {
    return {
      action: "refuse",
      reason: `Asset ${call.asset} is not in the asset list. Nothing was reserved.`,
      expiresAt: null,
    };
  }
  if (policy.allowPayTo.length > 0 && !listed(call.payTo, policy.allowPayTo)) {
    return {
      action: "refuse",
      reason: `payTo ${call.payTo} is not in allowPayTo. Nothing was reserved.`,
      expiresAt: null,
    };
  }
  const host = hostAllowed(call.host, policy.allowHosts);
  if (!host.ok) return { action: "refuse", reason: host.reason, expiresAt: null };
  if (amount > BigInt(policy.ceilingAtomic)) {
    return {
      action: "refuse",
      reason: `Amount ${amount.toString()} exceeds the per-call ceiling ${policy.ceilingAtomic}. Nothing was reserved.`,
      expiresAt: null,
    };
  }
  if (amount > money.remaining) {
    return {
      action: "refuse",
      reason: `Amount ${amount.toString()} exceeds remaining budget ${money.remaining.toString()} (budget ${policy.budgetAtomic}, spent ${money.spent.toString()}, reserved ${money.reserved.toString()}). Nothing was reserved.`,
      expiresAt: null,
    };
  }
  if (!humanApproved && amount > BigInt(policy.humanThresholdAtomic)) {
    return {
      action: "ask_human",
      reason: `Amount ${amount.toString()} is above the human threshold ${policy.humanThresholdAtomic}. No reservation was taken. A person has to run: spend-gate approve <key>`,
      expiresAt: null,
    };
  }
  const challengeTtl = call.maxTimeoutSeconds && call.maxTimeoutSeconds > 0 ? call.maxTimeoutSeconds : policy.reservationTtlSeconds;
  const ttl = Math.max(1, Math.min(policy.reservationTtlSeconds, challengeTtl));
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  return {
    action: "sign",
    reason: "Within policy. This tool did not sign.",
    expiresAt,
  };
}

function receiptOf(state: KeyState): ReceiptView | null {
  if (!state.settlement || !state.fulfilment || !state.refund || !state.recordedAt) return null;
  if (state.phase !== "recorded" && state.settlement !== "unsent") return null;
  return {
    idempotencyKey: state.idempotencyKey,
    amount: state.call.amount,
    resource: state.call.resource,
    host: state.call.host,
    network: state.call.network,
    asset: state.call.asset,
    payTo: state.call.payTo,
    settlement: state.settlement,
    fulfilment: state.fulfilment,
    refund: state.refund,
    reference: state.reference ?? null,
    attested: true,
    valueMovedByThisTool: false,
    recordedAt: state.recordedAt,
  };
}

function actionOf(state: KeyState): Action {
  if (state.phase === "reserved") return "sign";
  if (state.phase === "pending_human") return "ask_human";
  if (state.phase === "recorded") return "already_recorded";
  if (state.phase === "released") return "released";
  return "refuse";
}

function decisionFrom(state: KeyState, policy: Policy, money: Totals, persisted: boolean, action?: Action): Decision {
  const chosen = action ?? actionOf(state);
  const receipt = receiptOf(state);
  return {
    action: chosen,
    persisted,
    reason: state.reason,
    idempotencyKey: state.idempotencyKey,
    resource: state.call.resource,
    host: state.call.host,
    amount: state.call.amount,
    amountFormatted: formatAmount(state.call.amount, policy.decimals, policy.symbol),
    network: state.call.network,
    asset: state.call.asset,
    payTo: state.call.payTo,
    scheme: state.call.scheme,
    budgetAtomic: policy.budgetAtomic,
    budgetFormatted: formatAmount(policy.budgetAtomic, policy.decimals, policy.symbol),
    spentAtomic: money.spent.toString(),
    spentFormatted: formatAmount(money.spent, policy.decimals, policy.symbol),
    reservedAtomic: money.reserved.toString(),
    reservedFormatted: formatAmount(money.reserved, policy.decimals, policy.symbol),
    remainingAtomic: money.remaining.toString(),
    remainingFormatted: formatAmount(money.remaining, policy.decimals, policy.symbol),
    reservationExpiresAt: state.phase === "reserved" ? state.expiresAt ?? null : null,
    receipt,
    warnings: money.warnings,
    valueMovedByThisTool: false,
  };
}

function previewDecision(call: StoredCall, policy: Policy, money: Totals, judgment: Judgment, key: string): Decision {
  const state: KeyState = {
    idempotencyKey: key,
    phase: judgment.action === "sign" ? "reserved" : judgment.action === "ask_human" ? "pending_human" : "refused",
    call,
    reason: judgment.reason,
    at: "",
    expiresAt: judgment.expiresAt ?? undefined,
  };
  // A preview does not take the reservation, so remaining is the live balance.
  return { ...decisionFrom(state, policy, money, false, judgment.action), reservationExpiresAt: null };
}

function lineFor(judgment: Judgment, key: string, call: StoredCall, now: Date): LedgerLine {
  const at = now.toISOString();
  if (judgment.action === "sign" && judgment.expiresAt) {
    return { v: 1, type: "reservation", at, expiresAt: judgment.expiresAt, idempotencyKey: key, call, reason: judgment.reason };
  }
  if (judgment.action === "ask_human") {
    return { v: 1, type: "pending_human", at, idempotencyKey: key, call, reason: judgment.reason };
  }
  return { v: 1, type: "refusal", at, idempotencyKey: key, call, reason: judgment.reason };
}

function bookAfter(lines: LedgerLine[], extra: LedgerLine[], warnings: string[], now: Date, policy: Policy): { book: Book; money: Totals } {
  const book = fold([...lines, ...extra]);
  book.warnings.push(...warnings);
  return { book, money: totals(book, policy, now) };
}

function assertSameCall(existing: KeyState, call: StoredCall): void {
  if (!sameCall(existing.call, call)) {
    throw new GateError(
      "conflict",
      `Idempotency key ${existing.idempotencyKey} was already used for ${existing.call.resource} amount ${existing.call.amount}. Use a new key for a different call.`,
    );
  }
}

function openReservation(state: KeyState, now: Date): boolean {
  return state.phase === "reserved" && !!state.expiresAt && Date.parse(state.expiresAt) > now.getTime();
}

export async function evaluate(args: DecideArgs): Promise<Decision> {
  const now = args.now ?? new Date();
  const call = parseChallenge(args.input, {
    resource: args.resource,
    acceptIndex: args.acceptIndex,
    networks: args.policy.networks,
  });
  const key = args.idempotencyKey?.trim() ? requireKey(args.idempotencyKey) : "";
  return updateLedger(args.policy.ledgerPath, (loaded) => {
    const book = fold(loaded.lines);
    book.warnings.push(...loaded.warnings);
    const money = totals(book, args.policy, now);
    if (key) {
      const existing = book.keys.get(key);
      if (existing) {
        assertSameCall(existing, call);
        if (existing.phase === "recorded" || existing.phase === "denied" || existing.phase === "pending_human" || openReservation(existing, now)) {
          return { append: [], value: decisionFrom(existing, args.policy, money, true) };
        }
      }
    }
    const judgment = judge(call, args.policy, money, now, false);
    return { append: [], value: previewDecision(call, args.policy, money, judgment, key || "(preview)") };
  });
}

export async function decide(args: DecideArgs): Promise<Decision> {
  const now = args.now ?? new Date();
  const call = parseChallenge(args.input, {
    resource: args.resource,
    acceptIndex: args.acceptIndex,
    networks: args.policy.networks,
  });
  const key = freshKey(args.idempotencyKey);
  return updateLedger(args.policy.ledgerPath, (loaded) => {
    const expired = expiryLines(loaded.lines, now);
    const { book, money } = bookAfter(loaded.lines, expired, loaded.warnings, now, args.policy);
    const existing = book.keys.get(key);
    if (existing) {
      assertSameCall(existing, call);
      if (existing.phase === "recorded" || existing.phase === "denied" || existing.phase === "pending_human" || openReservation(existing, now)) {
        return { append: expired, value: decisionFrom(existing, args.policy, money, true) };
      }
    }
    const judgment = judge(call, args.policy, money, now, false);
    if (judgment.action === "sign" && judgment.expiresAt) {
      judgment.reason = `Within policy. A local reservation expires at ${judgment.expiresAt}. This tool did not sign.`;
    }
    const line = lineFor(judgment, key, call, now);
    const next = bookAfter(loaded.lines, [...expired, line], loaded.warnings, now, args.policy);
    const state = next.book.keys.get(key);
    if (!state) throw new GateError("invalid_ledger", `Decision for ${key} was not stored.`);
    return { append: [...expired, line], value: decisionFrom(state, args.policy, next.money, true, judgment.action) };
  });
}

export async function approve(args: KeyArgs): Promise<Decision> {
  const now = args.now ?? new Date();
  const key = requireKey(args.idempotencyKey);
  return updateLedger(args.policy.ledgerPath, (loaded) => {
    const expired = expiryLines(loaded.lines, now);
    const { book, money } = bookAfter(loaded.lines, expired, loaded.warnings, now, args.policy);
    const existing = book.keys.get(key);
    if (!existing) {
      throw new GateError("not_found", `No decision for ${key}. Run decide before approve.`);
    }
    if (openReservation(existing, now)) {
      return { append: expired, value: decisionFrom(existing, args.policy, money, true) };
    }
    if (existing.phase !== "pending_human") {
      throw new GateError(
        "conflict",
        `Cannot approve ${key}: it is ${existing.phase}. ${existing.reason}`,
      );
    }
    const judgment = judge(existing.call, args.policy, money, now, true);
    if (judgment.action === "sign" && judgment.expiresAt) {
      judgment.reason = `A person approved this call. A local reservation expires at ${judgment.expiresAt}. This tool did not sign.`;
    }
    const line = lineFor(judgment, key, existing.call, now);
    const next = bookAfter(loaded.lines, [...expired, line], loaded.warnings, now, args.policy);
    const state = next.book.keys.get(key);
    if (!state) throw new GateError("invalid_ledger", `Approval for ${key} was not stored.`);
    return { append: [...expired, line], value: decisionFrom(state, args.policy, next.money, true, judgment.action) };
  });
}

export async function deny(args: KeyArgs): Promise<Decision> {
  const now = args.now ?? new Date();
  const key = requireKey(args.idempotencyKey);
  return updateLedger(args.policy.ledgerPath, (loaded) => {
    const expired = expiryLines(loaded.lines, now);
    const { book, money } = bookAfter(loaded.lines, expired, loaded.warnings, now, args.policy);
    const existing = book.keys.get(key);
    if (!existing) throw new GateError("not_found", `No decision for ${key}.`);
    if (existing.phase === "denied") {
      return { append: expired, value: decisionFrom(existing, args.policy, money, true, "refuse") };
    }
    if (existing.phase !== "pending_human") {
      throw new GateError("conflict", `Cannot deny ${key}: it is ${existing.phase}, not waiting for a person.`);
    }
    const reason = "A person denied this call. Nothing was reserved and nothing was signed.";
    const line: LedgerLine = { v: 1, type: "denied", at: now.toISOString(), idempotencyKey: key, reason };
    const next = bookAfter(loaded.lines, [...expired, line], loaded.warnings, now, args.policy);
    const state = next.book.keys.get(key);
    if (!state) throw new GateError("invalid_ledger", `Denial for ${key} was not stored.`);
    return { append: [...expired, line], value: decisionFrom(state, args.policy, next.money, true, "refuse") };
  });
}

function refundFor(settlement: Settlement, fulfilment: Fulfilment): Refund {
  if (settlement === "unsent") return "not_applicable";
  if (fulfilment === "accepted") return "none_owed";
  if (fulfilment === "rejected") return "not_refunded";
  return "unknown";
}

function receiptReason(settlement: Settlement, fulfilment: Fulfilment, refund: Refund): string {
  if (settlement === "unsent") {
    return "The caller reported that nothing was sent. The reservation was released and the budget was not spent.";
  }
  if (refund === "not_refunded") {
    return "The caller attested a payment and rejected the result. The receipt stays. This tool does not refund, and the exact scheme does not reverse it here.";
  }
  if (fulfilment === "accepted") {
    return `The caller attested settlement ${settlement} and accepted the result. Nothing is owed back. This tool did not move the payment.`;
  }
  return `The caller attested settlement ${settlement} with fulfilment ${fulfilment}. Refund status is unknown. This tool did not move the payment.`;
}

export async function record(args: RecordArgs): Promise<Decision> {
  const now = args.now ?? new Date();
  const key = requireKey(args.idempotencyKey);
  if (!["accepted", "rejected", "unknown"].includes(args.fulfilment)) {
    throw new GateError("usage", "fulfilment must be accepted, rejected, or unknown.");
  }
  if (!["signed", "simulated", "unsent"].includes(args.settlement)) {
    throw new GateError("usage", "settlement must be signed, simulated, or unsent.");
  }
  const reference = args.reference?.trim() ? args.reference.trim() : null;
  if (reference && reference.length > 200) {
    throw new GateError("usage", "reference must be at most 200 characters. This tool stores it. It does not look it up on a chain.");
  }
  return updateLedger(args.policy.ledgerPath, (loaded) => {
    const expired = expiryLines(loaded.lines, now);
    const { book, money } = bookAfter(loaded.lines, expired, loaded.warnings, now, args.policy);
    const existing = book.keys.get(key);
    if (!existing) throw new GateError("not_found", `No decision for ${key}. Run decide before record.`);
    if (existing.phase === "recorded" && existing.settlement && existing.fulfilment) {
      const same =
        existing.settlement === args.settlement &&
        existing.fulfilment === args.fulfilment &&
        (existing.reference ?? null) === reference;
      if (!same) {
        throw new GateError(
          "conflict",
          `Key ${key} already has a receipt (${existing.settlement}, ${existing.fulfilment}). Refusing to overwrite it.`,
        );
      }
      return { append: expired, value: decisionFrom(existing, args.policy, money, true, "already_recorded") };
    }
    if (existing.phase === "pending_human") {
      throw new GateError("conflict", `Key ${key} is waiting for a person. approve or deny it before record.`);
    }
    if (existing.phase === "refused" || existing.phase === "denied") {
      throw new GateError("conflict", `Key ${key} was refused. Nothing was signed, so there is no receipt to write. ${existing.reason}`);
    }
    if (existing.phase === "released" && existing.settlement === "unsent") {
      return { append: expired, value: decisionFrom(existing, args.policy, money, true, "released") };
    }
    if (!openReservation(existing, now)) {
      throw new GateError(
        "conflict",
        `Key ${key} has no open reservation. If it expired, run decide again with the same key before paying.`,
      );
    }
    const refund = refundFor(args.settlement, args.fulfilment);
    const reason = receiptReason(args.settlement, args.fulfilment, refund);
    const line: LedgerLine = {
      v: 1,
      type: "receipt",
      at: now.toISOString(),
      idempotencyKey: key,
      call: existing.call,
      settlement: args.settlement,
      fulfilment: args.fulfilment,
      refund,
      reference,
      reason,
    };
    const next = bookAfter(loaded.lines, [...expired, line], loaded.warnings, now, args.policy);
    const state = next.book.keys.get(key);
    if (!state) throw new GateError("invalid_ledger", `Receipt for ${key} was not stored.`);
    const action: Action = args.settlement === "unsent" ? "released" : "already_recorded";
    return { append: [...expired, line], value: decisionFrom(state, args.policy, next.money, true, action) };
  });
}

function entryOf(state: KeyState, policy: Policy, now: Date): LedgerEntry {
  const open = openReservation(state, now);
  return {
    idempotencyKey: state.idempotencyKey,
    phase: state.phase === "reserved" && !open ? "released" : state.phase,
    action: state.phase === "reserved" && !open ? "released" : actionOf(state),
    reason: state.phase === "reserved" && !open ? "The reservation expired before a receipt was written." : state.reason,
    at: state.at,
    resource: state.call.resource,
    host: state.call.host,
    amount: state.call.amount,
    amountFormatted: formatAmount(state.call.amount, policy.decimals, policy.symbol),
    network: state.call.network,
    asset: state.call.asset,
    payTo: state.call.payTo,
    reservationExpiresAt: open ? state.expiresAt ?? null : null,
    settlement: state.settlement ?? null,
    fulfilment: state.fulfilment ?? null,
    refund: state.refund ?? null,
    reference: state.reference ?? null,
  };
}

export async function summarize(policy: Policy, now: Date = new Date()): Promise<LedgerSummary> {
  return updateLedger(policy.ledgerPath, (loaded) => {
    const book = fold(loaded.lines);
    book.warnings.push(...loaded.warnings);
    const money = totals(book, policy, now);
    const entries = [...book.keys.values()]
      .map((state) => entryOf(state, policy, now))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const counts = {
      recorded: 0,
      pendingHuman: 0,
      reserved: 0,
      refused: 0,
      denied: 0,
      released: 0,
    };
    for (const entry of entries) {
      if (entry.phase === "recorded") counts.recorded += 1;
      else if (entry.phase === "pending_human") counts.pendingHuman += 1;
      else if (entry.phase === "reserved") counts.reserved += 1;
      else if (entry.phase === "refused") counts.refused += 1;
      else if (entry.phase === "denied") counts.denied += 1;
      else counts.released += 1;
    }
    const summary: LedgerSummary = {
      configPath: policy.configPath,
      ledgerPath: policy.ledgerPath,
      budgetAtomic: policy.budgetAtomic,
      budgetFormatted: formatAmount(policy.budgetAtomic, policy.decimals, policy.symbol),
      spentAtomic: money.spent.toString(),
      spentFormatted: formatAmount(money.spent, policy.decimals, policy.symbol),
      reservedAtomic: money.reserved.toString(),
      reservedFormatted: formatAmount(money.reserved, policy.decimals, policy.symbol),
      remainingAtomic: money.remaining.toString(),
      remainingFormatted: formatAmount(money.remaining, policy.decimals, policy.symbol),
      counts,
      entries: entries.slice(0, 200),
      truncated: entries.length > 200,
      warnings: money.warnings,
      valueMovedByThisTool: false,
    };
    return { append: [], value: summary };
  });
}

export async function expireReservations(policy: Policy, now: Date = new Date()): Promise<LedgerSummary> {
  await updateLedger(policy.ledgerPath, (loaded) => {
    return { append: expiryLines(loaded.lines, now), value: undefined };
  });
  return summarize(policy, now);
}

export function exitCode(decision: Decision): number {
  if (decision.action === "refuse") return 2;
  if (decision.action === "ask_human") return 3;
  return 0;
}
