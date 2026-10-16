import { describe, expect, it } from "vitest";
import { capForEstimate } from "../components/StartFlow";
import { parseTokens } from "../format";

describe("v0.17.5 the cap follows the estimate", () => {
  it("raises a Settings cap below the estimate's high end, with 30% headroom, and says so", () => {
    const f = capForEstimate("500K", 1_490_000)!;
    expect(parseTokens(f.cap)).toBeGreaterThanOrEqual(1_490_000 * 1.3);
    expect(f.note).toMatch(/raised this flow's cap from 500k \(Settings\)/);
  });
  it("keeps a cap that is enough, and no cap at all", () => {
    expect(capForEstimate("2M", 1_000_000)).toBeNull();
    expect(capForEstimate("0", 1_000_000)).toBeNull();
    expect(capForEstimate("", 1_000_000)).toBeNull();
  });
});
