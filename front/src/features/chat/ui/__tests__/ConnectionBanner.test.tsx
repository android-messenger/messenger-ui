import {describe, it, expect, vi, beforeEach} from "vitest";
import {render, fireEvent} from "@testing-library/react";
import {ConnectionBanner} from "../ConnectionBanner.tsx";

vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));

const dispatch = vi.fn();
let wsState: {status: string; superseded: boolean};
vi.mock("react-redux", () => ({
    useDispatch: () => dispatch,
    useSelector: (sel: (s: unknown) => unknown) => sel({ws: wsState}),
}));

beforeEach(() => {
    dispatch.mockClear();
    wsState = {status: "connected", superseded: false};
});

describe("ConnectionBanner", () => {
    it("renders nothing when connected", () => {
        const {container} = render(<ConnectionBanner/>);
        expect(container.firstChild).toBeNull();
    });

    it("shows the reconnecting bar when disconnected", () => {
        wsState = {status: "disconnected", superseded: false};
        const {container} = render(<ConnectionBanner/>);
        expect(container.textContent).toContain("chat.noConnection");
    });

    it("shows the take-over notice + a reconnect button when superseded", () => {
        wsState = {status: "disconnected", superseded: true};
        const {container} = render(<ConnectionBanner/>);
        expect(container.textContent).toContain("chat.sessionElsewhere");
        expect(container.textContent).toContain("chat.reconnectHere");
    });

    it("the reconnect button dispatches a reconnecting ws/connect", () => {
        wsState = {status: "disconnected", superseded: true};
        const {getByText} = render(<ConnectionBanner/>);
        fireEvent.click(getByText("chat.reconnectHere"));
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({type: "ws/connect", meta: {shouldReconnect: true}}),
        );
    });
});
