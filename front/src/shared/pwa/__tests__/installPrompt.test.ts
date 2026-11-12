import {describe, it, expect, vi} from "vitest";
import {canInstall, promptInstall, wasInstalled} from "../installPrompt.ts";

// The module arms window listeners at import time; drive it with synthetic events. State is module-level, so
// these run in order: no captured prompt → capture → consume (one-shot) → appinstalled.
function fireBeforeInstallPrompt(outcome: "accepted" | "dismissed") {
    const e = new Event("beforeinstallprompt") as Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: string}>};
    e.prompt = vi.fn(async () => {});
    e.userChoice = Promise.resolve({outcome});
    window.dispatchEvent(e);
    return e;
}

describe("installPrompt capture", () => {
    it("no captured prompt → not installable, promptInstall is a no-op false", async () => {
        expect(canInstall()).toBe(false);
        expect(await promptInstall()).toBe(false);
    });

    it("captures the event → installable, and accepting resolves true then consumes it (one-shot)", async () => {
        const e = fireBeforeInstallPrompt("accepted");
        expect(canInstall()).toBe(true);
        expect(await promptInstall()).toBe(true);
        expect(e.prompt).toHaveBeenCalledTimes(1);
        expect(canInstall()).toBe(false);              // consumed — can't be summoned again
        expect(await promptInstall()).toBe(false);
    });

    it("a dismissed choice resolves false", async () => {
        fireBeforeInstallPrompt("dismissed");
        expect(await promptInstall()).toBe(false);
    });

    it("appinstalled flips wasInstalled and clears any pending prompt", () => {
        fireBeforeInstallPrompt("accepted");
        window.dispatchEvent(new Event("appinstalled"));
        expect(wasInstalled()).toBe(true);
        expect(canInstall()).toBe(false);
    });
});
