// Titles and notes keel or an agent writes with `code` show it as code, not as raw backticks.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Ticks } from "../components/ui";

describe("Ticks", () => {
  it("shows `code` spans as code and leaves the rest plain", () => {
    const { container } = render(<p><Ticks text="verify failed: `npm test` exited 1 in `web/`" /></p>);
    expect(container.textContent).toBe("verify failed: npm test exited 1 in web/");
    expect([...container.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["npm test", "web/"]);
    const { container: plain } = render(<p><Ticks text="a lone ` tick stays" /></p>);
    expect(plain.textContent).toBe("a lone ` tick stays");
    expect(plain.querySelector("code")).toBeNull();
  });
});
