import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {renderHook, act} from "@testing-library/react";
import {OUTBOX_RETRY_TICK_MS} from "@/shared/config/outbox.ts";

const {dispatchSpy} = vi.hoisted(() => ({dispatchSpy: vi.fn()}));
vi.mock("react-redux", () => ({useDispatch: () => dispatchSpy}));
vi.mock("@/features/chat/thunk/sendOutboxThunk.ts", () => ({flushOutbox: () => ({type: "outbox/flush"})}));

import {useOutboxRetry} from "../useOutboxRetry";

describe("useOutboxRetry", () => {
    beforeEach(() => { vi.useFakeTimers(); dispatchSpy.mockClear(); });
    afterEach(() => vi.useRealTimers());

    it("dispatches flushOutbox on each tick and stops after unmount", () => {
        const {unmount} = renderHook(() => useOutboxRetry());

        act(() => { vi.advanceTimersByTime(OUTBOX_RETRY_TICK_MS); });
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        expect(dispatchSpy).toHaveBeenLastCalledWith({type: "outbox/flush"});

        act(() => { vi.advanceTimersByTime(OUTBOX_RETRY_TICK_MS); });
        expect(dispatchSpy).toHaveBeenCalledTimes(2);

        unmount();
        act(() => { vi.advanceTimersByTime(OUTBOX_RETRY_TICK_MS * 3); });
        expect(dispatchSpy).toHaveBeenCalledTimes(2); // interval cleared — no more dispatches
    });
});
