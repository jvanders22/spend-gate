import type { Decision, LedgerEntry, LedgerSummary } from "./types.js";

export function formatDecision(decision: Decision): string {
  const head =
    decision.action === "sign"
      ? "SIGN"
      : decision.action === "ask_human"
        ? "ASK A PERSON"
        : decision.action === "already_recorded"
          ? "ALREADY RECORDED"
          : decision.action === "released"
            ? "RELEASED"
            : "REFUSE";
  const lines = [
    head,
    decision.reason,
    `resource  ${decision.resource}`,
    `host      ${decision.host}`,
    `amount    ${decision.amountFormatted} (${decision.amount} atomic)`,
    `network   ${decision.network}`,
    `asset     ${decision.asset}`,
    `payTo     ${decision.payTo}`,
    `key       ${decision.idempotencyKey}`,
    `budget    ${decision.budgetFormatted}   spent ${decision.spentFormatted}   reserved ${decision.reservedFormatted}   remaining ${decision.remainingFormatted}`,
  ];
  if (decision.reservationExpiresAt) lines.push(`expires   ${decision.reservationExpiresAt}`);
  if (decision.receipt) {
    const reference = decision.receipt.reference ? `   reference ${decision.receipt.reference}` : "";
    lines.push(
      `receipt   ${decision.receipt.settlement}   fulfilment ${decision.receipt.fulfilment}   refund ${decision.receipt.refund}${reference}`,
    );
  }
  lines.push(decision.persisted ? "persisted yes" : "persisted no (preview only, nothing was written)");
  lines.push("This tool did not sign and did not move value.");
  for (const warning of decision.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export function formatLedger(summary: LedgerSummary): string {
  const lines = [
    `config    ${summary.configPath}`,
    `ledger    ${summary.ledgerPath}`,
    `budget    ${summary.budgetFormatted} (${summary.budgetAtomic} atomic)`,
    `spent     ${summary.spentFormatted} (${summary.spentAtomic} atomic)`,
    `reserved  ${summary.reservedFormatted} (${summary.reservedAtomic} atomic)`,
    `remaining ${summary.remainingFormatted} (${summary.remainingAtomic} atomic)`,
    `counts    recorded ${summary.counts.recorded}  reserved ${summary.counts.reserved}  pending ${summary.counts.pendingHuman}  refused ${summary.counts.refused}  denied ${summary.counts.denied}  released ${summary.counts.released}`,
  ];
  if (summary.entries.length === 0) lines.push("entries   none");
  for (const entry of summary.entries) {
    const refund = entry.refund ? `  refund ${entry.refund}` : "";
    lines.push(`${entry.idempotencyKey}  ${entry.phase}  ${entry.amountFormatted}  ${entry.host}${refund}`);
  }
  if (summary.truncated) lines.push("entries truncated to the latest 200. Pass --json for the same cap.");
  lines.push("This tool did not sign and did not move value.");
  for (const warning of summary.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

const PHASE_SENTENCE: Record<string, string> = {
  refused: "Refused by policy. Nothing was reserved.",
  pending_human: "Waiting for a person. Nothing is reserved yet.",
  reserved: "Approved and reserved. The caller has not reported a result yet.",
  released: "Released. The reservation was given back and nothing was spent.",
  denied: "A person denied it. Nothing was reserved.",
  recorded: "Recorded. The caller reported what happened.",
};

const REFUND_SENTENCE: Record<string, string> = {
  none_owed: "none owed",
  not_refunded: "NOT refunded (this tool cannot reverse a payment)",
  unknown: "unknown",
  not_applicable: "not applicable, nothing was paid",
};

export function formatReceipt(entry: LedgerEntry): string {
  const lines = [
    `RECEIPT ${entry.idempotencyKey}`,
    PHASE_SENTENCE[entry.phase] ?? entry.phase,
    `bought    ${entry.resource}`,
    `merchant  ${entry.host}`,
    `amount    ${entry.amountFormatted}`,
    `paid to   ${entry.payTo} on ${entry.network}`,
    `why       ${entry.reason}`,
    `when      ${entry.at}`,
  ];
  if (entry.settlement) {
    lines.push(`outcome   settlement ${entry.settlement}, result ${entry.fulfilment ?? "unknown"}`);
    lines.push(`refund    ${REFUND_SENTENCE[entry.refund ?? "unknown"]}`);
    if (entry.reference) lines.push(`reference ${entry.reference} (caller-supplied, not verified)`);
  }
  if (entry.phase === "pending_human") lines.push(`approve   spend-gate approve ${entry.idempotencyKey}`);
  lines.push("This tool did not sign and did not move value.");
  return lines.join("\n");
}

export function formatPending(entries: LedgerEntry[]): string {
  if (entries.length === 0) return "Nothing is waiting for a person.";
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(
      `${entry.idempotencyKey}  ${entry.amountFormatted}  ${entry.host}  ${entry.resource}`,
      `  approve: spend-gate approve ${entry.idempotencyKey}    deny: spend-gate deny ${entry.idempotencyKey}`,
    );
  }
  return lines.join("\n");
}
