import { GateError } from "./errors.js";

/** Canonical integer string: no leading zeros, except the value zero itself. */
export function canonicalAtomic(raw: string): string {
  const stripped = raw.replace(/^0+/, "");
  return stripped.length === 0 ? "0" : stripped;
}

export function parseAtomic(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new GateError(
      "invalid_amount",
      `${label} must be a non-negative integer in atomic units. Got ${JSON.stringify(value)}.`,
    );
  }
  return BigInt(value);
}

export function formatAmount(atomic: string | bigint, decimals: number, symbol: string): string {
  const n = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const negative = n < 0n;
  const value = negative ? -n : n;
  if (decimals === 0) return `${negative ? "-" : ""}${value.toString()} ${symbol}`;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const rendered = fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
  return `${negative ? "-" : ""}${rendered} ${symbol}`;
}
