export interface StoredCall {
  resource: string;
  host: string;
  amount: string;
  network: string;
  asset: string;
  payTo: string;
  scheme: string;
  maxTimeoutSeconds: number | null;
  description: string;
}

export type Action = "sign" | "refuse" | "ask_human" | "already_recorded" | "released";
export type Settlement = "signed" | "simulated" | "unsent";
export type Fulfilment = "accepted" | "rejected" | "unknown";
export type Refund = "none_owed" | "not_refunded" | "unknown" | "not_applicable";

export interface ReceiptView {
  idempotencyKey: string;
  amount: string;
  resource: string;
  host: string;
  network: string;
  asset: string;
  payTo: string;
  settlement: Settlement;
  fulfilment: Fulfilment;
  refund: Refund;
  reference: string | null;
  attested: true;
  valueMovedByThisTool: false;
  recordedAt: string;
}

export interface Decision {
  action: Action;
  persisted: boolean;
  reason: string;
  idempotencyKey: string;
  resource: string;
  host: string;
  amount: string;
  amountFormatted: string;
  network: string;
  asset: string;
  payTo: string;
  scheme: string;
  budgetAtomic: string;
  budgetFormatted: string;
  spentAtomic: string;
  spentFormatted: string;
  reservedAtomic: string;
  reservedFormatted: string;
  remainingAtomic: string;
  remainingFormatted: string;
  reservationExpiresAt: string | null;
  receipt: ReceiptView | null;
  warnings: string[];
  valueMovedByThisTool: false;
}

export interface LedgerEntry {
  idempotencyKey: string;
  phase: "refused" | "pending_human" | "reserved" | "released" | "denied" | "recorded";
  action: Action;
  reason: string;
  at: string;
  resource: string;
  host: string;
  amount: string;
  amountFormatted: string;
  network: string;
  asset: string;
  payTo: string;
  reservationExpiresAt: string | null;
  settlement: Settlement | null;
  fulfilment: Fulfilment | null;
  refund: Refund | null;
  reference: string | null;
}

export interface LedgerSummary {
  configPath: string;
  ledgerPath: string;
  budgetAtomic: string;
  budgetFormatted: string;
  spentAtomic: string;
  spentFormatted: string;
  reservedAtomic: string;
  reservedFormatted: string;
  remainingAtomic: string;
  remainingFormatted: string;
  counts: {
    recorded: number;
    pendingHuman: number;
    reserved: number;
    refused: number;
    denied: number;
    released: number;
  };
  entries: LedgerEntry[];
  truncated: boolean;
  warnings: string[];
  valueMovedByThisTool: false;
}

export type ReleaseReason = "expired" | "denied" | "unsent";

export type LedgerLine =
  | { v: 1; type: "refusal"; at: string; idempotencyKey: string; call: StoredCall; reason: string }
  | { v: 1; type: "pending_human"; at: string; idempotencyKey: string; call: StoredCall; reason: string }
  | {
      v: 1;
      type: "reservation";
      at: string;
      expiresAt: string;
      idempotencyKey: string;
      call: StoredCall;
      reason: string;
    }
  | { v: 1; type: "release"; at: string; idempotencyKey: string; reason: ReleaseReason }
  | { v: 1; type: "denied"; at: string; idempotencyKey: string; reason: string }
  | {
      v: 1;
      type: "receipt";
      at: string;
      idempotencyKey: string;
      call: StoredCall;
      settlement: Settlement;
      fulfilment: Fulfilment;
      refund: Refund;
      reference: string | null;
      reason: string;
    };
