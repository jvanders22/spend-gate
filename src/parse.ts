import { GateError } from "./errors.js";
import { canonicalAtomic } from "./money.js";
import type { StoredCall } from "./types.js";

export interface ParseOptions {
  resource?: string;
  acceptIndex?: number;
  networks?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeChallengeDocument(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new GateError("invalid_challenge", "The challenge is empty.");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch (err) {
      throw new GateError("invalid_challenge", `Challenge JSON did not parse: ${(err as Error).message}`);
    }
  }
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  } catch {
    decoded = "";
  }
  if (decoded.startsWith("{") || decoded.startsWith("[")) {
    try {
      return JSON.parse(decoded) as unknown;
    } catch (err) {
      throw new GateError(
        "invalid_challenge",
        `PAYMENT-REQUIRED base64 decoded, but the JSON did not parse: ${(err as Error).message}`,
      );
    }
  }
  throw new GateError(
    "invalid_challenge",
    "Expected a JSON challenge or a base64 PAYMENT-REQUIRED value. The input was neither.",
  );
}

function resourceString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (isRecord(value) && typeof value.url === "string" && value.url.trim().length > 0) return value.url.trim();
  return undefined;
}

function normaliseUrl(raw: string): { href: string; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GateError("invalid_challenge", `resource is not a URL: ${raw.slice(0, 160)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GateError("invalid_challenge", "resource must be an http or https URL.");
  }
  if (url.username || url.password) {
    throw new GateError(
      "invalid_challenge",
      "resource URL contains credentials. Remove the username and password.",
    );
  }
  if (!url.hostname) throw new GateError("invalid_challenge", "resource URL has no hostname.");
  return { href: url.href, host: url.hostname };
}

function atomicValue(accept: Record<string, unknown>): string {
  const amount = accept.amount;
  const maxAmount = accept.maxAmountRequired;
  if (amount !== undefined && maxAmount !== undefined) {
    const left = oneAtomic(amount, "amount");
    const right = oneAtomic(maxAmount, "maxAmountRequired");
    if (left !== right) {
      throw new GateError(
        "invalid_challenge",
        `amount (${left}) and maxAmountRequired (${right}) disagree. Refusing to guess the price.`,
      );
    }
    return left;
  }
  if (amount !== undefined) return oneAtomic(amount, "amount");
  if (maxAmount !== undefined) return oneAtomic(maxAmount, "maxAmountRequired");
  throw new GateError(
    "invalid_challenge",
    'The challenge has no amount. Expected "amount" or "maxAmountRequired" as a string of atomic units.',
  );
}

function oneAtomic(raw: unknown, label: string): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.includes(".")) {
      throw new GateError(
        "invalid_challenge",
        `${label} must be atomic integer units, not a decimal. With 6 decimals, 0.01 is "10000".`,
      );
    }
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new GateError("invalid_challenge", `${label} must be a string of atomic units. Got ${JSON.stringify(trimmed)}.`);
    }
    if (trimmed.length > 78) throw new GateError("invalid_challenge", `${label} is unreasonably long.`);
    return canonicalAtomic(trimmed);
  }
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new GateError(
        "invalid_challenge",
        `${label} is a JSON number that is not a safe integer. Send atomic units as a string.`,
      );
    }
    return canonicalAtomic(String(raw));
  }
  throw new GateError("invalid_challenge", `${label} must be a string of atomic units.`);
}

function requiredString(accept: Record<string, unknown>, key: string, max: number): string {
  const value = accept[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    throw new GateError("invalid_challenge", `${key} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function timeoutOf(accept: Record<string, unknown>): number | null {
  const value = accept.maxTimeoutSeconds;
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function acceptsOf(body: Record<string, unknown>): Record<string, unknown>[] | null {
  const raw = Array.isArray(body.accepts)
    ? body.accepts
    : Array.isArray(body.paymentRequirements)
      ? body.paymentRequirements
      : null;
  if (!raw) return null;
  if (!raw.every(isRecord)) {
    throw new GateError("invalid_challenge", "accepts must be an array of payment requirement objects.");
  }
  return raw;
}

function pickAccept(body: Record<string, unknown>, options: ParseOptions): Record<string, unknown> {
  const accepts = acceptsOf(body);
  if (!accepts) return body;
  const exact = accepts.filter((accept) => String(accept.scheme ?? "").toLowerCase() === "exact");
  if (exact.length === 0) {
    const schemes = accepts.map((accept) => String(accept.scheme ?? "missing")).join(", ");
    throw new GateError(
      "invalid_challenge",
      `No exact-scheme option in accepts. Schemes seen: ${schemes}. spend-gate prices a single exact amount and will not guess an upto or batch quote.`,
    );
  }
  if (options.acceptIndex !== undefined) {
    const chosen = exact[options.acceptIndex];
    if (!chosen) {
      throw new GateError(
        "invalid_challenge",
        `accept index ${options.acceptIndex} is out of range. There are ${exact.length} exact option(s).`,
      );
    }
    return chosen;
  }
  const networks = options.networks ?? [];
  if (networks.length > 0) {
    const matched = exact.find((accept) => typeof accept.network === "string" && networks.includes(accept.network));
    if (!matched) {
      const offered = exact.map((accept) => String(accept.network ?? "missing")).join(", ");
      throw new GateError(
        "invalid_challenge",
        `None of the exact options use an allowed network. Offered: ${offered}. Allowed: ${networks.join(", ")}.`,
      );
    }
    return matched;
  }
  return exact[0] as Record<string, unknown>;
}

export function sameCall(left: StoredCall, right: StoredCall): boolean {
  return (
    left.resource === right.resource &&
    left.amount === right.amount &&
    left.network === right.network &&
    left.asset.toLowerCase() === right.asset.toLowerCase() &&
    left.payTo.toLowerCase() === right.payTo.toLowerCase() &&
    left.scheme === right.scheme
  );
}

export function parseChallenge(input: unknown, options: ParseOptions = {}): StoredCall {
  const document = typeof input === "string" ? decodeChallengeDocument(input) : input;
  if (!isRecord(document)) {
    throw new GateError("invalid_challenge", "The challenge must be a JSON object.");
  }
  const accept = pickAccept(document, options);
  const fromBody = resourceString(document.resource);
  const fromAccept = resourceString(accept.resource);
  const quoted = fromBody ?? fromAccept;
  let rawResource = options.resource?.trim() || quoted;
  if (!rawResource) {
    throw new GateError(
      "invalid_challenge",
      "The challenge has no resource URL. Pass the URL you are about to pay. The hostname allowlist cannot be checked without it.",
    );
  }
  if (options.resource && quoted) {
    const wanted = normaliseUrl(options.resource);
    const offered = normaliseUrl(quoted);
    if (wanted.href !== offered.href) {
      throw new GateError(
        "invalid_challenge",
        `resource ${wanted.href} does not match the challenge resource ${offered.href}. Refusing to decide a payment for a different URL than the one that was quoted.`,
      );
    }
    rawResource = offered.href;
  }
  const url = normaliseUrl(rawResource);
  const descriptionRaw = accept.description ?? document.description;
  const description = typeof descriptionRaw === "string" ? descriptionRaw.slice(0, 240) : "";
  return {
    resource: url.href,
    host: url.host,
    amount: atomicValue(accept),
    network: requiredString(accept, "network", 80),
    asset: requiredString(accept, "asset", 200),
    payTo: requiredString(accept, "payTo", 200),
    scheme: requiredString(accept, "scheme", 40).toLowerCase(),
    maxTimeoutSeconds: timeoutOf(accept),
    description,
  };
}
