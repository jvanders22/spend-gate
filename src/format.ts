import type { Decision, LedgerSummary } from "./types.js";

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
