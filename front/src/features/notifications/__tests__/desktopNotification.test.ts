import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {showDesktopNotification, showCallNotification} from "../desktopNotification";

// showDesktopNotification must route the ONLINE notification through the service worker (the single
// arbiter), carrying messageId so the SW can dedup it against an offline Web Push for the same
// message. It must also respect notification permission.

function stubNotification(permission: string) {
    const NotificationMock = vi.fn() as unknown as { permission: string };
    NotificationMock.permission = permission;
    vi.stubGlobal("Notification", NotificationMock);
}

function stubServiceWorker(active: {postMessage: (m: unknown) => void} | null) {
    const reg = {active, showNotification: vi.fn<(title: string, options?: NotificationOptions) => Promise<void>>(() => Promise.resolve())};
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {ready: Promise.resolve(reg)},
    });
    return reg;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe("showDesktopNotification — SW arbiter routing", () => {
    beforeEach(() => stubNotification("granted"));

    it("posts a show-notification message to the active SW with messageId + conversationId", async () => {
        const postMessage = vi.fn();
        stubServiceWorker({postMessage});
        showDesktopNotification("Title", "hello", "conv-1", "msg-ulid-1");
        await flush();
        expect(postMessage).toHaveBeenCalledTimes(1);
        const arg = postMessage.mock.calls[0][0] as {type: string; payload: {title: string; body: string; tag: string; data: {conversationId: string; messageId: string}}};
        expect(arg.type).toBe("show-notification");
        expect(arg.payload).toMatchObject({title: "Title", body: "hello", tag: "conv-1"});
        expect(arg.payload.data).toMatchObject({conversationId: "conv-1", messageId: "msg-ulid-1"});
    });

    it("does nothing when permission is not granted", async () => {
        stubNotification("default");
        const postMessage = vi.fn();
        stubServiceWorker({postMessage});
        showDesktopNotification("Title", "hello", "conv-1", "msg-ulid-1");
        await flush();
        expect(postMessage).not.toHaveBeenCalled();
    });

    it("falls back to reg.showNotification when there is no active SW", async () => {
        const reg = stubServiceWorker(null);
        showDesktopNotification("Title", "hello", "conv-1", "msg-ulid-1");
        await flush();
        expect(reg.showNotification).toHaveBeenCalledTimes(1);
        expect(reg.showNotification.mock.calls[0][0]).toBe("Title");
    });
});

describe("showCallNotification — local call alert (online-but-backgrounded)", () => {
    beforeEach(() => stubNotification("granted"));

    it("posts a kind=call notification to the SW with an answer deep-link", async () => {
        const postMessage = vi.fn();
        stubServiceWorker({postMessage});
        showCallNotification({conversationId: "conv-1", callerId: "user-2", media: "audio"});
        await flush();
        expect(postMessage).toHaveBeenCalledTimes(1);
        const arg = postMessage.mock.calls[0][0] as {type: string; payload: {tag: string; data: {kind: string; conversationId: string; senderId: string; media: string; url: string}}};
        expect(arg.type).toBe("show-notification");
        expect(arg.payload.tag).toBe("call:conv-1");
        expect(arg.payload.data).toMatchObject({kind: "call", conversationId: "conv-1", senderId: "user-2", media: "audio"});
        // notificationclick deep-links to the answer flow.
        expect(arg.payload.data.url).toContain("call=conv-1");
        expect(arg.payload.data.url).toContain("caller=user-2");
        expect(arg.payload.data.url).toContain("media=audio");
    });

    it("does nothing when permission is not granted", async () => {
        stubNotification("default");
        const postMessage = vi.fn();
        stubServiceWorker({postMessage});
        showCallNotification({conversationId: "conv-1", callerId: "user-2"});
        await flush();
        expect(postMessage).not.toHaveBeenCalled();
    });

    it("falls back to reg.showNotification (call title) when there is no active SW", async () => {
        const reg = stubServiceWorker(null);
        showCallNotification({conversationId: "conv-1", callerId: "user-2"});
        await flush();
        expect(reg.showNotification).toHaveBeenCalledTimes(1);
        expect(reg.showNotification.mock.calls[0][0]).toBe("Incoming call");
    });
});
