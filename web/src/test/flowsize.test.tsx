// keel 0.18.12 "pick the size for me": keel reads the words of a request and marks the flow that fits (quick, implement,
// small, change, feature, or fix for a bug); Start a flow shows the sizes with their steps and estimate, the person picks.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { suggestFlow } from "../flowSize";
import * as fx from "./fixtures";
import { db } from "./setup";

const ALL = ["quick", "implement", "small", "change", "feature", "fix"];

describe("suggestFlow", () => {
  it("sizes a request by its words", () => {
    expect(suggestFlow("Fix the typo in the owner page title", ALL)?.id).toBe(
      "quick",
    );
    expect(
      suggestFlow("The visit date is wrong on the pet page", ALL)?.id,
    ).toBe("quick");
    expect(
      suggestFlow(
        "Show the number of visits per pet on the owner details page",
        ALL,
      )?.id,
    ).toBe("small");
    expect(
      suggestFlow("Add a vets schedule with a new table and a migration", ALL),
    ).toEqual({
      id: "feature",
      why: "it touches table: worth a spec and the full checks",
    });
    expect(
      suggestFlow(
        "Add a search box for owners, code first and the tests after",
        ALL,
      )?.id,
    ).toBe("implement");
    expect(
      suggestFlow(
        `Checkout breaks when ${"the cart has many items and ".repeat(5)}the user pays`,
        ALL,
      )?.id,
    ).toBe("fix");
    expect(suggestFlow("- a\n- b\n- c\n- d\n- e", ALL)?.id).toBe("feature");
    expect(suggestFlow("   ", ALL)).toBeNull();
  });

  it("suggests the address flow when only test code changes", () => {
    const all = [...ALL, "address"];
    expect(
      suggestFlow(
        "Maybe a factory would fit here? tests/Integration/OrderHandlerTest.php:42 inserts its rows in setUp()",
        all,
      ),
    ).toEqual({ id: "address", why: "only test code changes" });
    expect(
      suggestFlow(
        "Use one helper in web/src/cart.test.ts and tests/test_orders.py",
        all,
      )?.id,
    ).toBe("address");
    // a production file named too: not test-only
    expect(
      suggestFlow(
        "Move the totals from src/Orders/OrderTotal.php into tests/Unit/OrderTotalTest.php",
        all,
      )?.id,
    ).not.toBe("address");
    // a project without the address flow: quick, the next one that is not test-first
    expect(
      suggestFlow("Rename the helper in tests/test_orders.py", ALL),
    ).toEqual({ id: "quick", why: "only test code changes" });
  });

  it("only suggests a flow the project has", () => {
    expect(
      suggestFlow("Fix the typo in the title", ["small", "feature"])?.id,
    ).toBe("small");
    expect(suggestFlow("Fix the typo in the title", ["feature"])).toBeNull();
  });
});

describe("Start a flow: how big is it?", () => {
  it("shows the sizes with their steps and estimate, marks the one that fits, and Use picks it", async () => {
    const user = userEvent.setup();
    db.workflows.push(
      ...["quick", "small", "implement"].map((id) => ({
        ...fx.fixWorkflow,
        id,
        name: `${id} (keel)`,
        steps: fx.fixWorkflow.steps.slice(0, 3),
      })),
    );
    localStorage.setItem("keel2.project", "yegi");
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Start a flow" }),
    );
    const dlg = await screen.findByRole("dialog", { name: "Start a flow" });
    const sizes = await within(dlg).findByRole("radiogroup", {
      name: "Size of the flow",
    });
    expect(
      within(sizes)
        .getAllByRole("radio")
        .map((r) => r.querySelector("b")?.textContent),
    ).toEqual(["quick", "implement", "small", "feature"]);
    expect(
      within(sizes).getByRole("radio", { name: /^feature/ }),
    ).toHaveAttribute("aria-checked", "true"); // keel's default stays
    await waitFor(() =>
      expect(
        within(sizes).getByRole("radio", { name: /^quick/ }),
      ).toHaveTextContent("3 steps · ≈"),
    );

    await user.type(
      within(dlg).getByLabelText("What to build"),
      "Fix the typo in the owner page title",
    );
    expect(within(dlg).getByTestId("sf-suggest")).toHaveTextContent(
      "keel suggests quick: a small, clear change (typo).",
    );
    expect(
      within(sizes).getByRole("radio", { name: /^quick/ }),
    ).toHaveTextContent("keel suggests");
    expect(
      within(sizes).getByRole("radio", { name: /^feature/ }),
    ).toHaveAttribute("aria-checked", "true"); // only marked, not picked

    await user.click(within(dlg).getByRole("button", { name: "Use quick" }));
    expect(
      within(sizes).getByRole("radio", { name: /^quick/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(dlg).getByLabelText("Workflow")).toHaveValue("quick");
    expect(within(dlg).queryByRole("button", { name: "Use quick" })).toBeNull();
  });

  it("hides the sizes for a flow that is not a size (a review)", async () => {
    const user = userEvent.setup();
    db.workflows.push(
      { ...fx.fixWorkflow, id: "quick", name: "quick (keel)" },
      { ...fx.fixWorkflow, id: "review", name: "review (keel)" },
    );
    localStorage.setItem("keel2.project", "yegi");
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Start a flow" }),
    );
    const dlg = await screen.findByRole("dialog", { name: "Start a flow" });
    await within(dlg).findByRole("radiogroup", { name: "Size of the flow" });
    await user.selectOptions(within(dlg).getByLabelText("Workflow"), "review");
    expect(
      within(dlg).queryByRole("radiogroup", { name: "Size of the flow" }),
    ).toBeNull();
  });
});
