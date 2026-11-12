import {describe, it, expect, vi, beforeEach, type Mock} from "vitest";
import {renderHook} from "@testing-library/react";
import {useSelector} from "react-redux";
import {useCallRingtone} from "../useCallRingtone";
import {startRinging, stopRinging} from "@/shared/sound/notify.ts";

vi.mock("react-redux", () => ({useSelector: vi.fn()}));
vi.mock("@/shared/sound/notify.ts", () => ({startRinging: vi.fn(), stopRinging: vi.fn()}));

const setStatus = (status: string) =>
    (useSelector as unknown as Mock).mockImplementation((sel: (s: unknown) => unknown) => sel({call: {status}}));

describe("useCallRingtone", () => {
    beforeEach(() => vi.clearAllMocks());

    it("rings while a call is inbound-ringing", () => {
        setStatus("ringing");
        renderHook(() => useCallRingtone());
        expect(startRinging).toHaveBeenCalledTimes(1);
        expect(stopRinging).not.toHaveBeenCalled();
    });

    it("rings while dialing (calling)", () => {
        setStatus("calling");
        renderHook(() => useCallRingtone());
        expect(startRinging).toHaveBeenCalledTimes(1);
    });

    it.each(["connecting", "in_call", "idle"])("stops the ring on %s", (status) => {
        setStatus(status);
        renderHook(() => useCallRingtone());
        expect(startRinging).not.toHaveBeenCalled();
        expect(stopRinging).toHaveBeenCalled();
    });

    it("stops the ring on unmount", () => {
        setStatus("ringing");
        const {unmount} = renderHook(() => useCallRingtone());
        vi.clearAllMocks();
        unmount();
        expect(stopRinging).toHaveBeenCalledTimes(1);
    });
});
