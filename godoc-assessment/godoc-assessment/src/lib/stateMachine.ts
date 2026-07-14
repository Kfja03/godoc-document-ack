export type DocumentStatus = "UPLOADED" | "ACKNOWLEDGED" | "REJECTED";

export type DocumentEvent = "ACKNOWLEDGE" | "REJECT";

// UPLOADED is the only non-terminal state. From it, the second party can
// either acknowledge (happy path) or reject (documented edge case) the
// document. Both ACKNOWLEDGED and REJECTED are terminal - once a party has
// acted, the decision cannot be silently overwritten by a later request.
const TRANSITIONS: Record<DocumentStatus, Partial<Record<DocumentEvent, DocumentStatus>>> = {
  UPLOADED: {
    ACKNOWLEDGE: "ACKNOWLEDGED",
    REJECT: "REJECTED",
  },
  ACKNOWLEDGED: {},
  REJECTED: {},
};

export function canTransition(from: DocumentStatus, event: DocumentEvent): boolean {
  return TRANSITIONS[from]?.[event] !== undefined;
}

export function nextState(from: DocumentStatus, event: DocumentEvent): DocumentStatus {
  const next = TRANSITIONS[from]?.[event];
  if (!next) {
    throw new Error(`Invalid transition: cannot apply ${event} from state ${from}`);
  }
  return next;
}
