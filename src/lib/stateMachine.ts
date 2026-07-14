export type DocumentStatus = "UPLOADED" | "ACKNOWLEDGED" | "REJECTED" | "NEEDS_REVISION";

export type DocumentEvent = "ACKNOWLEDGE" | "REJECT" | "REQUEST_REVISION" | "RESUBMIT";

// UPLOADED is where every document starts and the only state an approver
// acts on directly. From it, an approver can:
//   - ACKNOWLEDGE it (happy path, terminal)
//   - REJECT it outright (terminal - wrong/invalid document, no path back)
//   - REQUEST_REVISION (the document is broadly right but needs a fix or
//     more information - not a flat rejection)
// NEEDS_REVISION is the one non-terminal, non-UPLOADED state: the uploader
// (or a lead, on anyone's behalf) can RESUBMIT a corrected file, which
// moves it back to UPLOADED for a fresh review. ACKNOWLEDGED and REJECTED
// are both terminal - once a decision is made, it isn't silently
// overwritten by a later request.
const TRANSITIONS: Record<DocumentStatus, Partial<Record<DocumentEvent, DocumentStatus>>> = {
  UPLOADED: {
    ACKNOWLEDGE: "ACKNOWLEDGED",
    REJECT: "REJECTED",
    REQUEST_REVISION: "NEEDS_REVISION",
  },
  NEEDS_REVISION: {
    RESUBMIT: "UPLOADED",
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
