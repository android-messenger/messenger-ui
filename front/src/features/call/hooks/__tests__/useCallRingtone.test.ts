import {describe, it, expect, vi, beforeEach, type Mock} from "vitest";
import {renderHook} from "@testing-library/react";
import {useSelector} from "react-redux";
import {useCallRingtone} from "../useCallRingtone";
import {startRinging, stopRinging} from "@/shared/sound/notify.ts";

vi.mock("react-redux", () => ({useSelector: vi.fn()}));
vi.mock("@/shared/sound/notify.ts", () => ({startRinging: vi.fn(), stopRinging: vi.fn()}));
const app = {native: false, ringback: vi.fn(async (o: {on: boolean}) => { void o; })};
vi.mock("@/shared/platform.ts", () => ({isNativeApp: () => app.native, callPlugin: () => ({ringback: app.ringback})}));

const setStatus = (status: string) =>
    (useSelector as unknown as Mock).mockImplementation((sel: (s: unknown) => unknown) => sel({call: {status}}));

describe("useCallRingtone", () => {
    beforeEach(() => { vi.clearAllMocks(); app.native = false; });

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

    // Android app: the app takes the audio for the call, so the page's player is silent while dialling
    // and came back after the call was dropped. The app plays the ringback itself.
    it("Android app, dialing: asks the app for the ringback and plays nothing in the page", () => {
        app.native = true;
        setStatus("calling");
        const {unmount} = renderHook(() => useCallRingtone());
        expect(app.ringback).toHaveBeenCalledWith({on: true});
        expect(startRinging).not.toHaveBeenCalled();
        unmount();
        expect(app.ringback).toHaveBeenLastCalledWith({on: false});
    });

    it("Android app, incoming call: the page rings as before", () => {
        app.native = true;
        setStatus("ringing");
        renderHook(() => useCallRingtone());
        expect(startRinging).toHaveBeenCalledTimes(1);
        expect(app.ringback).not.toHaveBeenCalled();
    });
});
