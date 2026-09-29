import { GateError } from "./errors.js";
import { decodeChallengeDocument } from "./parse.js";

export type ProbeHit =
  | { kind: "challenge"; status: number; challenge: unknown; url: string }
  | { kind: "no_payment"; status: number; snippet: string; url: string }
  | { kind: "redirect"; status: number; location: string | null; url: string };

const MAX_BYTES = 1_000_000;

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

async function readLimited(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_BYTES) {
    throw new GateError(
      "probe_failed",
      `Response Content-Length ${declared} is above ${MAX_BYTES} bytes. spend-gate only reads a payment challenge, and it sent no payment.`,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new GateError(
        "probe_failed",
        `Response exceeded ${MAX_BYTES} bytes before a payment challenge was isolated. No payment was sent.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * GET a URL and look for an x402 challenge. Never sends a payment header and never follows redirects.
 */
export async function probe(url: string, timeoutMs = 12_000): Promise<ProbeHit> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GateError("probe_failed", `Not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GateError("probe_failed", "probe only fetches http and https URLs.");
  }
  if (parsed.username || parsed.password) {
    throw new GateError("probe_failed", "Remove credentials from the URL before probing.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed.href, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain",
        "user-agent": "spend-gate/0.1 (policy check; sends no payment)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { kind: "redirect", status: response.status, location: response.headers.get("location"), url: parsed.href };
    }
    const body = await readLimited(response);
    const header = response.headers.get("payment-required");
    let headerError = "";
    if (header) {
      try {
        return { kind: "challenge", status: response.status, challenge: decodeChallengeDocument(header), url: parsed.href };
      } catch (err) {
        headerError = err instanceof Error ? err.message : String(err);
      }
    }
    if (response.status === 402 || header) {
      try {
        return { kind: "challenge", status: response.status, challenge: decodeChallengeDocument(body), url: parsed.href };
      } catch (err) {
        const bodyError = err instanceof Error ? err.message : String(err);
        throw new GateError(
          "invalid_challenge",
          `HTTP ${response.status} looked like a payment challenge but it did not parse. ${headerError} ${bodyError}`.trim(),
        );
      }
    }
    return { kind: "no_payment", status: response.status, snippet: snippet(body), url: parsed.href };
  } catch (err) {
    if (err instanceof GateError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GateError("probe_failed", `Timed out after ${timeoutMs}ms fetching ${parsed.href}. No payment was sent.`);
    }
    throw new GateError("probe_failed", `Could not fetch ${parsed.href}: ${(err as Error).message}. No payment was sent.`);
  } finally {
    clearTimeout(timer);
  }
}
