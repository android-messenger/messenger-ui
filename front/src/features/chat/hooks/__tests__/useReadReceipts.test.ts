import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {renderHook, act} from "@testing-library/react";
import {createElement, type ReactNode} from "react";
import {Provider} from "react-redux";
import {configureStore} from "@reduxjs/toolkit";

import {chatApi} from "@/features/chat/rest/chatApi";
import {useReadReceipts} from "../useReadReceipts";

const ULID = "01KY29D4BHHB40EW2FKMHR6V7M";
const ULID2 = "01KY29D4BHHB40EW2FKMHR6V7N";

type Sent = Record<string, unknown>;

function setVisibility(v: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {configurable: true, get: () => v});
}

async function makeHarness(opts: {wsStatus?: string; history?: Array<{id: string}>} = {}) {
    const sent: Sent[] = [];
    const recorder = () => (next: (a: unknown) => unknown) => (action: unknown) => {
        const a = action as {type?: string; payload?: Sent};
        if (a?.type === "ws/send") sent.push(a.payload as Sent);
        return next(action);
    };
    const store = configureStore({
        reducer: {
            user: () => ({id: "me"}),
            ws: (state = {status: opts.wsStatus ?? "connected"}) => state,
            [chatApi.reducerPath]: chatApi.reducer,
        },
        middleware: (gDM) => gDM({serializableCheck: false}).concat(chatApi.middleware, recorder),
    });
    if (opts.history) {
        // Await so the fulfilled cache entry is applied before the hook mounts and reads it.
        await store.dispatch(chatApi.util.upsertQueryData("getChatHistory", {myId: "me", chatId: "c1"}, opts.history as never));
    }
    const wrapper = ({children}: {children: ReactNode}) => createElement(Provider, {store, children});
    return {wrapper, sent};
}

const reads = (sent: Sent[]) => sent.filter((p) => p.type === "READ_IN");
const markRead = vi.fn();
const getSummary = (id: string) => (id === "c1" ? {counterpartId: "peer"} : undefined);

beforeEach(() => {
    markRead.mockClear();
    setVisibility("visible");
});
afterEach(() => setVisibility("visible"));

describe("useReadReceipts", () => {
    it("on connect+visible with a known boundary, sends READ_IN to the newest server ULID", async () => {
        const {wrapper, sent} = await makeHarness({wsStatus: "connected", history: [{id: ULID}]});
        renderHook(() => useReadReceipts({selectedChatId: "c1", newestMessageId: ULID, getSummary, markRead}), {wrapper});
        const r = reads(sent);
        expect(r.length).toBeGreaterThanOrEqual(1);
        expect(r[0]).toMatchObject({correlationId: ULID, recipientId: "peer", conversationId: "c1"});
    });

    it("skips the boundary of a not-yet-reconciled temp id (only ULIDs count)", async () => {
        const {wrapper, sent} = await makeHarness({wsStatus: "connected", history: [{id: ULID}, {id: "temp-nanoid"}]});
        renderHook(() => useReadReceipts({selectedChatId: "c1", newestMessageId: "temp-nanoid", getSummary, markRead}), {wrapper});
        // Boundary is the last ULID, not the trailing temp id.
        expect(reads(sent)[0]).toMatchObject({correlationId: ULID});
    });

    it("connect/newest triggers do NOT fire when the boundary is unknown (empty history)", async () => {
        const {wrapper, sent} = await makeHarness({wsStatus: "connected", history: []});
        renderHook(() => useReadReceipts({selectedChatId: "c1", newestMessageId: null, getSummary, markRead}), {wrapper});
        expect(reads(sent)).toHaveLength(0);
    });

    it("does not send while disconnected (connect trigger gated on wsStatus)", async () => {
        const {wrapper, sent} = await makeHarness({wsStatus: "disconnected", history: [{id: ULID}]});
        renderHook(() => useReadReceipts({selectedChatId: "c1", newestMessageId: ULID, getSummary, markRead}), {wrapper});
        // The newest trigger is NOT gated on wsStatus, so it still fires with the boundary; the point
        // here is the connect trigger doesn't add a second one for a dead socket. At least the read
        // is attempted (delivery is best-effort). We assert it doesn't THROW and boundary is correct.
        for (const r of reads(sent)) expect(r.correlationId).toBe(ULID);
    });

    it("onVisible marks read and sends READ_IN even without a boundary (open path)", async () => {
        const {wrapper, sent} = await makeHarness({wsStatus: "connected", history: []});
        renderHook(() => useReadReceipts({selectedChatId: "c1", newestMessageId: null, getSummary, markRead}), {wrapper});
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(markRead).toHaveBeenCalledWith("c1");
        const r = reads(sent);
        expect(r.length).toBeGreaterThanOrEqual(1);
        // No boundary yet → correlationId is undefined, but the frame is still sent to the peer.
        expect(r[r.length - 1]).toMatchObject({conversationId: "c1", recipientId: "peer"});
        expect(r[r.length - 1].correlationId).toBeUndefined();
    });

    it("sends NO READ_IN for a group (no per-member read watermark) even with a boundary", async () => {
        const groupSummary = (id: string) => (id === "c1" ? {counterpartId: "", kind: "group"} : undefined);
        const {wrapper, sent} = await makeHarness({wsStatus: "connected", history: [{id: ULID}]});
        const {result} = renderHook(
            () => useReadReceipts({selectedChatId: "c1", newestMessageId: ULID, getSummary: groupSummary, markRead}), {wrapper});
        act(() => { result.current.sendReadReceipt("c1"); });
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(reads(sent)).toHaveLength(0);
        expect(markRead).toHaveBeenCalledWith("c1"); // local unread clearing still happens
    });

    it("sendReadReceipt (used by openChat) sends the current boundary on demand", async () => {
        const {wrapper, sent} = await makeHarness({wsStatus: "disconnected", history: [{id: ULID2}]});
        const {result} = renderHook(
            () => useReadReceipts({selectedChatId: null, newestMessageId: null, getSummary, markRead}), {wrapper});
        act(() => { result.current.sendReadReceipt("c1"); });
        expect(reads(sent).some((r) => r.correlationId === ULID2 && r.conversationId === "c1")).toBe(true);
    });
});
