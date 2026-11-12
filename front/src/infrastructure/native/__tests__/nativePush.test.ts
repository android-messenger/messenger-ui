import {describe, it, expect, afterEach, vi} from "vitest";
import {tapRoute} from "../tapRoute.ts";
import {ensurePushSubscription, removePushSubscription} from "@/features/notifications/push.ts";
import {queueNativeNames} from "@/features/directory/nameCache.ts";
import {push} from "@/shared/platform.ts";

const g = globalThis as { Capacitor?: unknown };

describe("native push (S1 §6, §7)", () => {
    afterEach(() => { delete g.Capacitor; vi.useRealTimers(); });

    it("routes notification taps", () => {
        expect(tapRoute({conversationId: "c1"})).toBe("/?chat=c1");
        expect(tapRoute({call: {conversationId: "c2", callerId: "u9", media: "audio"}})).toBe("/?call=c2&caller=u9&media=audio");
        expect(tapRoute({call: {conversationId: "c2", callerId: "u9"}, conversationId: "c1"})).toBe("/?call=c2&caller=u9");
        expect(tapRoute({call: {conversationId: "c2", callerId: "u9", media: "video", accept: true}})).toBe("/?call=c2&caller=u9&media=video&accept=1");
        expect(tapRoute({})).toBeNull();
    });

    it("push() only in the app", () => {
        expect(() => push()).toThrow();
    });

    it("register / unregister go to the native plugin in the app", async () => {
        const plugin = {register: vi.fn(async () => ({result: "ok"})), unregister: vi.fn(async () => {})};
        g.Capacitor = {isNativePlatform: () => true, Plugins: {Push: plugin}};
        await ensurePushSubscription();
        await removePushSubscription();
        expect(plugin.register).toHaveBeenCalledOnce();
        expect(plugin.unregister).toHaveBeenCalledOnce();
    });

    it("a failing native register never throws", async () => {
        g.Capacitor = {isNativePlatform: () => true, Plugins: {Push: {register: async () => { throw new Error("x"); }}}};
        await expect(ensurePushSubscription()).resolves.toBeUndefined();
    });

    it("batches names to the native cache at most once per 10 s", () => {
        vi.useFakeTimers();
        const updateContactNames = vi.fn(async () => {});
        g.Capacitor = {isNativePlatform: () => true, Plugins: {Push: {updateContactNames}}};
        queueNativeNames({a: "Ann"});
        queueNativeNames({b: "Bob"});
        vi.advanceTimersByTime(0);
        expect(updateContactNames).toHaveBeenCalledTimes(1);
        expect(updateContactNames).toHaveBeenLastCalledWith({names: {a: "Ann", b: "Bob"}});
        queueNativeNames({c: "Cid"});
        vi.advanceTimersByTime(5_000);
        expect(updateContactNames).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_000);
        expect(updateContactNames).toHaveBeenCalledTimes(2);
        expect(updateContactNames).toHaveBeenLastCalledWith({names: {c: "Cid"}});
    });
});
