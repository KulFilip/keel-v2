// B15 a cap someone saved in Settings is the flow's cap: Start a flow never raises it to the estimate (keel's default
// cap still follows the estimate, v02.test.tsx).

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import * as fx from "./fixtures";
import { server } from "./setup";

describe("Start a flow: a saved Settings cap (B15)", () => {
  it("keeps the saved cap and says it is below the estimate", async () => {
    server.use(http.get("/api/projects/:pid/settings", () => HttpResponse.json({ ...fx.projectSettings({}), general_saved: ["cap_tokens"] })));
    const user = userEvent.setup();
    localStorage.setItem("keel2.project", "yegi");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Start a flow" }));
    const dlg = await screen.findByRole("dialog", { name: "Start a flow" });
    await user.type(within(dlg).getByLabelText("What to build"), "Rank next to top 10");
    expect(await within(dlg).findByTestId("sf-cap-low")).toHaveTextContent("below the estimate");
    expect(within(dlg).getByLabelText("Cap for this flow")).toHaveValue("500k");
    expect(within(dlg).queryByTestId("sf-cap-est")).toBeNull();
  });
});
