import { canTransition, nextState } from "../src/lib/stateMachine";

describe("document state machine", () => {
  it("allows ACKNOWLEDGE and REJECT from UPLOADED", () => {
    expect(canTransition("UPLOADED", "ACKNOWLEDGE")).toBe(true);
    expect(canTransition("UPLOADED", "REJECT")).toBe(true);
    expect(nextState("UPLOADED", "ACKNOWLEDGE")).toBe("ACKNOWLEDGED");
    expect(nextState("UPLOADED", "REJECT")).toBe("REJECTED");
  });

  it("does not allow any transition out of ACKNOWLEDGED (terminal state)", () => {
    expect(canTransition("ACKNOWLEDGED", "ACKNOWLEDGE")).toBe(false);
    expect(canTransition("ACKNOWLEDGED", "REJECT")).toBe(false);
  });

  it("does not allow any transition out of REJECTED (terminal state)", () => {
    expect(canTransition("REJECTED", "ACKNOWLEDGE")).toBe(false);
    expect(canTransition("REJECTED", "REJECT")).toBe(false);
  });

  it("throws when asked to compute nextState for an invalid transition", () => {
    expect(() => nextState("ACKNOWLEDGED", "ACKNOWLEDGE")).toThrow();
  });
});
