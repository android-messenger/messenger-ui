// Audit 2026-11-12, finding 3: "Mark as verified" did not say WHICH key the user compared. The dialog shows
// the safety number of key K1; the peer's key is replaced by K2 while the dialog is open; the tap marked K2.
// Written by the auditor as a PoC of the hole; the assertions now state the fixed behaviour: the call carries
// the number that was on the screen, the library refuses when it is not the current one, and the dialog
// then shows the new number, not verified.
import {describe, it, expect, vi} from "vitest";
import {render, screen, fireEvent, waitFor} from "@testing-library/react";

const K1 = "1".repeat(60), K2 = "2".repeat(60);

const plugin = vi.hoisted(() => {
    const p = {
        current: "",
        verified: false,
        e2eeSafetyNumber: vi.fn(async () => ({digits: p.current})),
        e2eePeerState: vi.fn(async () => ({trust: p.verified ? "verified" : "passport", keyChanged: false})),
        // the library's rule (wolp-device-trust, SecretChats.setVerified)
        e2eeSetVerified: vi.fn<(o: {peer: string; verified: boolean; digits?: string}) => Promise<void>>(async (o) => {
            if (o.verified && o.digits !== p.current) throw Object.assign(new Error("e2ee refused"), {code: "reverify"});
            p.verified = o.verified;
        }),
    };
    (globalThis as {Capacitor?: unknown}).Capacitor = {isNativePlatform: () => true, Plugins: {DeviceTrust: p}};
    return p;
});

vi.mock("react-i18next", async (importOriginal) => ({...(await importOriginal<typeof import("react-i18next")>()), useTranslation: () => ({t: (k: string) => k})}));

import {SafetyNumberModal} from "../SafetyNumberModal.tsx";

const shown = () => document.body.textContent!.replace(/\s/g, "");

describe("audit, finding 3: the verified mark is bound to the number on the screen", () => {
    it("number of K1 is shown, the key becomes K2: the tap does not verify K2 and the new number is shown", async () => {
        plugin.current = K1;
        render(<SafetyNumberModal peerUserId="bob" peerName="Bob" onClose={() => {}}/>);
        const button = await screen.findByText("chat.safetyVerify");
        expect(shown()).toContain(K1);                                            // the user compares K1

        plugin.current = K2;                                                      // key replaced meanwhile
        fireEvent.click(button);
        await waitFor(() => expect(plugin.e2eeSetVerified).toHaveBeenCalledTimes(1));
        expect(plugin.e2eeSetVerified).toHaveBeenCalledWith({peer: "bob", verified: true, digits: K1});
        expect(plugin.verified).toBe(false);

        await waitFor(() => expect(shown()).toContain(K2));                       // compare again, with this one
        expect(shown()).not.toContain(K1);
        expect(screen.queryByText("chat.safetyUnverify")).toBeNull();

        fireEvent.click(screen.getByText("chat.safetyVerify"));                   // the user compared K2
        await screen.findByText("chat.safetyUnverify");
        expect(plugin.e2eeSetVerified).toHaveBeenLastCalledWith({peer: "bob", verified: true, digits: K2});
        expect(plugin.verified).toBe(true);
    });
});
