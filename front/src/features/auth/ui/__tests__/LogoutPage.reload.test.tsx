import {describe, it, expect, vi, beforeEach} from "vitest";
import {render, screen, fireEvent, waitFor} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";

// Spec 001, FR-004: after a logout the page is loaded anew (a full navigation to /login), so no key and
// no open database handle of the previous account stays in memory. Both logout pages leave that way.

const calls: string[] = [];
vi.mock("@/features/auth/model/services/fullLogout.ts", () => ({
    fullLogout: vi.fn(async () => { calls.push("logout"); }),
    goLoginAfterLogout: vi.fn(() => { calls.push("reload"); }),
}));
vi.mock("react-redux", () => ({useDispatch: () => vi.fn()}));
vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));

import LogoutPage from "../LogoutPage";
import AppOnlyPage from "../AppOnlyPage";

beforeEach(() => { calls.length = 0; });

describe("logout pages leave with a full page load", () => {
    it("LogoutPage: logout first, then the full navigation", async () => {
        render(<MemoryRouter><LogoutPage/></MemoryRouter>);
        fireEvent.click(screen.getByText("auth.logout"));
        await waitFor(() => expect(calls).toEqual(["logout", "reload"]));
    });

    it("AppOnlyPage: logs out on arrival; the button does the full navigation, once", async () => {
        render(<MemoryRouter><AppOnlyPage/></MemoryRouter>);
        await waitFor(() => expect(screen.getByText("auth.appOnlyOtherAccount")).toBeTruthy());
        expect(calls).toEqual(["logout"]);                       // no reload on arrival — it would loop
        fireEvent.click(screen.getByText("auth.appOnlyOtherAccount"));
        expect(calls).toEqual(["logout", "reload"]);
    });
});
