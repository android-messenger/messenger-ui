import {describe, it, expect, vi, beforeEach} from "vitest";

// Spec 002 §3.3 — Android app: every message from the socket is told to the app before the ACK.

vi.mock("@/features/chat/rest/chatApi.ts", () => ({
    chatApi: {
        util: {updateQueryData: vi.fn((endpoint, args, recipe) => ({type: "test/updateQueryData", endpoint, args, recipe}))},
        endpoints: {getChats: {select: vi.fn(() => () => ({data: [{conversationId: "c1"}]}))}},
    },
}));
vi.mock("@/features/groups/rest/groupApi.ts", () => ({
    groupApi: {endpoints: {getGroups: {select: vi.fn(() => () => ({data: []})), initiate: vi.fn(() => ({type: "test/groups"}))}}},
}));
vi.mock("@/features/chat/model/services/chatMessages.service.ts", () => ({chatMessagesService: {refetchChatsPreservingSelected: vi.fn()}}));
vi.mock("@/shared/sound/notify.ts", () => ({playNotificationSound: vi.fn()}));
vi.mock("@/features/notifications/desktopNotification.ts", () => ({showDesktopNotification: vi.fn()}));
vi.mock("@/shared/i18n", () => ({default: {t: (k: string) => k}}));

const app = vi.hoisted(() => ({native: true, backgrounded: false, order: [] as string[], notify: null as unknown as ReturnType<typeof vi.fn>}));
vi.mock("@/shared/platform.ts", () => ({
    isNativeApp: () => app.native,
    push: () => ({notifyMessage: (o: unknown) => app.notify(o)}),
}));
vi.mock("@/infrastructure/native/appLifecycle.ts", () => ({isAppBackgrounded: () => app.backgrounded}));

import {chatMiddleware} from "../chatMiddleware";
import {showDesktopNotification} from "@/features/notifications/desktopNotification.ts";

const SERVER_ID = "01KY29D4BHHB40EW2FKMHR6V7M";
const frame = {type: "CHAT_OUT", messageId: SERVER_ID, correlationId: "nano", conversationId: "c1", senderId: "peer", recipientId: "me",
    serverTimestamp: 1_700_000_000_000, payload: {body: "hi", kind: "text"}};

function run(selectedChatId: string | null) {
    const store = {
        dispatch: vi.fn((a: {type: string; payload?: {type?: string}}) => {
            if (a.type === "ws/send" && a.payload?.type === "CHAT_ACK") app.order.push("ack");
            return a;
        }),
        getState: vi.fn(() => ({user: {id: "me"}, chatUi: {selectedChatId}})),
    };
    chatMiddleware(store as never)(((a: unknown) => a) as never)({type: "ws/incoming", payload: frame});
}
const setHidden = (v: boolean) => Object.defineProperty(document, "hidden", {configurable: true, get: () => v});

describe("chatMiddleware — a socket message in the Android app", () => {
    beforeEach(() => {
        app.native = true; app.backgrounded = false; app.order = [];
        app.notify = vi.fn(async () => { app.order.push("told"); return {shown: false}; });
        vi.mocked(showDesktopNotification).mockClear();
        setHidden(false);
    });

    it("is told to the app with its server id, and only then acknowledged", () => {
        run("c1");
        expect(app.notify).toHaveBeenCalledWith({conversationId: "c1", messageId: SERVER_ID, senderId: "peer", hidden: false});
        expect(app.order).toEqual(["told", "ack"]);
    });

    it("says the user is not looking when the page is hidden or the app has gone to the background", () => {
        setHidden(true);
        run("c1");
        expect(app.notify).toHaveBeenLastCalledWith(expect.objectContaining({hidden: true}));
        expect(showDesktopNotification).not.toHaveBeenCalled();   // the app shows its own notification
        setHidden(false);
        app.backgrounded = true;
        run(null);
        expect(app.notify).toHaveBeenLastCalledWith(expect.objectContaining({hidden: true}));
    });

    it("an app without the method does not stop the message: it is still acknowledged", () => {
        app.notify = vi.fn(() => { throw new Error("not implemented"); });
        run("c1");
        expect(app.order).toEqual(["ack"]);
    });

    it("a browser is not asked", () => {
        app.native = false;
        run("c1");
        expect(app.notify).not.toHaveBeenCalled();
    });
});
