import "fake-indexeddb/auto";
import {beforeEach, describe, expect, it, vi} from "vitest";

// Spec 001, story 6 against a stand-in bridge (T063, T068): what the interface does in the Android app
// when the keys live in the app's library. The stand-in keeps the library's rules that matter here — a
// closed list of refusals, a "key changed" mark that stays until the user closes the notice, a "verified"
// mark bound to the number that was on the screen, no keys in any answer.

type Trust = "unverified" | "passport" | "verified" | "reverify";
const refuse = (code: string) => Object.assign(new Error("e2ee refused"), {code});

/** The bridge operations, scriptable per peer. */
function fakeBridge() {
    const peers = new Map<string, {trust: Trust; keyChanged: boolean; fail?: string; session: number}>();
    const peer = (id: string) => peers.get(id) ?? peers.set(id, {trust: "unverified", keyChanged: false, session: 1}).get(id)!;
    const calls: string[] = [];
    let locked = 0;
    const gate = (op: string) => { calls.push(op); if (locked > 0) { locked--; throw refuse("locked"); } };
    return {
        peer, calls,
        lockFor(n: number) { locked = n; },
        plugin: {
            vaultWrap: vi.fn(), vaultUnwrap: vi.fn(),
            async e2eeEncrypt({peer: id, text}: {peer: string; text: string}) {
                gate("encrypt");
                const p = peer(id);
                if (p.fail) throw refuse(p.fail);
                if (p.trust === "reverify") throw refuse("reverify");
                if (p.trust === "unverified") p.trust = "passport";
                return {envelope: `E2EE2:${p.session}.${btoa(unescape(encodeURIComponent(text)))}`};
            },
            async e2eeDecrypt({peer: id, envelope}: {peer: string; envelope: string}) {
                gate("decrypt");
                const p = peer(id);
                if (p.fail) throw refuse(p.fail);
                if (!envelope.startsWith("E2EE2:")) throw refuse("undecryptable");
                return {text: decodeURIComponent(escape(atob(envelope.split(".")[1])))};
            },
            async e2eePeerState({peer: id}: {peer: string}) {
                gate("peerState");
                const p = peer(id);
                return {trust: p.trust, keyChanged: p.keyChanged};   // reading does not take the mark off
            },
            async e2eeSafetyNumber({peer: id}: {peer: string}) {
                gate("safetyNumber");
                return peer(id).trust === "unverified" ? {} : {digits: "1".repeat(60)};
            },
            async e2eeSetVerified({peer: id, verified, digits}: {peer: string; verified: boolean; digits?: string}) {
                gate("setVerified");
                const p = peer(id);
                if (p.trust === "unverified") return;
                if (verified && digits !== "1".repeat(60)) throw refuse("reverify");   // not the current key's number
                p.trust = verified ? "verified" : "passport";
                p.keyChanged = false;
            },
            async e2eeKeyChangeSeen({peer: id}: {peer: string}) {
                gate("keyChangeSeen");
                peer(id).keyChanged = false;
            },
            async e2eeResetSession({peer: id}: {peer: string}) {
                gate("resetSession");
                peer(id).session++;
            },
            e2eeWipe: vi.fn(async () => { calls.push("wipe"); peers.clear(); }),
        },
    };
}

let bridge: ReturnType<typeof fakeBridge>;
vi.mock("@/shared/platform.ts", async (orig) => ({
    ...(await orig<typeof import("@/shared/platform.ts")>()),
    isNativeApp: () => true,
    deviceTrust: () => bridge.plugin,
    push: () => ({addListener: () => ({remove: async () => {}})}),
}));

const load = async () => {
    vi.resetModules();
    const crypto = await import("../crypto.ts");
    const keyChange = await import("../lib/keyChange.ts");
    const failure = await import("../lib/failure.ts");
    return {secretCrypto: crypto.secretCrypto, keyChange, failure};
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("secret chats in the Android app go through the bridge", () => {
    beforeEach(() => { bridge = fakeBridge(); localStorage.clear(); });

    it("6.1 — a message is encrypted and decrypted by the app; the Vault is never asked for a key", async () => {
        const {secretCrypto} = await load();
        const body = await secretCrypto.encrypt("bob", "привет");
        expect(body.startsWith("E2EE2:")).toBe(true);
        expect(await secretCrypto.decrypt("bob", body)).toBe("привет");
        await settle();
        expect(bridge.plugin.vaultUnwrap).not.toHaveBeenCalled();
        expect(bridge.plugin.vaultWrap).not.toHaveBeenCalled();
        expect(await secretCrypto.peerState("bob")).toEqual({trust: "passport", keyChanged: false});
    });

    it("6.2, 6.3, 6.6 — a key the app refuses stops the send, and the user is told why", async () => {
        const {secretCrypto, failure} = await load();
        const told: Record<string, string> = {};
        for (const code of ["no_passport", "bad_passport", "multi_device", "no_device", "no_network", "not_enrolled"]) {
            bridge.peer("bob").fail = code;
            const e = await secretCrypto.encrypt("bob", "x").then(() => null, (x: unknown) => x);
            expect(failure.refusalCode(e)).toBe(code);
            told[code] = failure.sendFailureKey(e);
        }
        expect(told).toEqual({
            no_passport: "chat.peerNotInApp",          // 6.6: the peer writes from a browser
            bad_passport: "chat.peerKeyRejected",      // 6.2: a wrong signature, somebody else's certificate
            multi_device: "chat.peerKeyRejected",      // 6.3
            no_device: "chat.peerNoKeys",
            no_network: "chat.keysOffline",
            not_enrolled: "chat.deviceNotEnrolled",
        });
        expect(failure.sendFailureKey(new Error("anything else"))).toBe("chat.encryptFailed");
    });

    it("6.4 — a changed key is noted for the chat's service line, once, on a send or on a receipt", async () => {
        const {secretCrypto, keyChange} = await load();
        await secretCrypto.encrypt("bob", "one");
        await settle();
        expect(keyChange.keyChangedPeers()).toEqual([]);

        bridge.peer("bob").keyChanged = true;
        await secretCrypto.decrypt("bob", "E2EE2:1." + btoa("two"));
        await settle();
        expect(keyChange.keyChangedPeers()).toEqual(["bob"]);

        // audit 2026-11-12, finding 2: the mark is the library's — a reload (nothing left in memory) and
        // any number of reads do not lose it
        keyChange.forgetKeyChanges();
        await secretCrypto.encrypt("bob", "three");
        await settle();
        expect(keyChange.keyChangedPeers()).toEqual(["bob"]);

        await secretCrypto.keyChangeSeen("bob");            // the user closed the line
        await secretCrypto.encrypt("bob", "four");
        await settle();
        expect(keyChange.keyChangedPeers()).toEqual([]);

        bridge.peer("carol").keyChanged = true;
        await secretCrypto.encrypt("carol", "x");
        await settle();
        expect(keyChange.keyChangedPeers()).toEqual(["carol"]);
    });

    it("6.5 — a verified contact whose key changed gets nothing until the user verifies again", async () => {
        const {secretCrypto, keyChange, failure} = await load();
        await secretCrypto.encrypt("bob", "x");
        await secretCrypto.setVerified("bob", true, "1".repeat(60));
        expect((await secretCrypto.peerState("bob")).trust).toBe("verified");

        bridge.peer("bob").trust = "reverify";
        const e = await secretCrypto.encrypt("bob", "y").then(() => null, (x: unknown) => x);
        expect(failure.sendFailureKey(e)).toBe("chat.peerReverify");
        expect(keyChange.keyChangedPeers()).toEqual(["bob"]);
        expect((await secretCrypto.peerState("bob")).trust).toBe("reverify");

        // audit 2026-11-12, finding 3: the number of another key does not set the mark
        await expect(secretCrypto.setVerified("bob", true, "2".repeat(60))).rejects.toMatchObject({code: "reverify"});
        expect((await secretCrypto.peerState("bob")).trust).toBe("reverify");

        await secretCrypto.setVerified("bob", true, "1".repeat(60));
        expect(await secretCrypto.encrypt("bob", "y")).toContain("E2EE2:");
    });

    it("6.7 — call parameters use the same operations, and a refusal is a refusal: nothing is returned to send", async () => {
        const {secretCrypto} = await load();
        const offer = JSON.stringify({type: "offer", sdp: "v=0…"});
        expect(JSON.parse(await secretCrypto.decrypt("bob", await secretCrypto.encrypt("bob", offer)))).toEqual({type: "offer", sdp: "v=0…"});
        bridge.peer("bob").fail = "no_passport";
        await expect(secretCrypto.encrypt("bob", offer)).rejects.toMatchObject({code: "no_passport"});
    });

    it("what the app could not read is classified by its reason, not by a message text", async () => {
        const {failure} = await load();
        const kind = (code: string) => failure.classifyDecryptError(refuse(code));
        expect(kind("duplicate")).toBe("duplicate");
        expect(kind("undecryptable")).toBe("hard-gap");
        expect(failure.isRecoverable(kind("undecryptable"))).toBe(true);
        for (const code of ["no_passport", "bad_passport", "multi_device"]) {
            expect(kind(code)).toBe("untrusted");
            expect(failure.isRecoverable(kind(code))).toBe(false);   // asking again would not make the key good
        }
        expect(failure.isRecoverable(kind("no_network"))).toBe(true);
        // an envelope of the browser implementation cannot be read in the app: it is asked for again
        const {secretCrypto} = await load();
        const e = await secretCrypto.decrypt("bob", "E2EE1:abc").then(() => null, (x: unknown) => x);
        expect(failure.classifyDecryptError(e)).toBe("hard-gap");
    });

    it("a locked phone makes the operation wait and run again; nothing is lost", async () => {
        const {secretCrypto} = await load();
        bridge.lockFor(1);
        const sent = secretCrypto.encrypt("bob", "after the unlock");
        document.dispatchEvent(new Event("visibilitychange"));     // the app came back to the foreground
        expect(await sent).toContain("E2EE2:");
        expect(bridge.calls.filter((c) => c === "encrypt").length).toBe(2);
    });

    it("recovery: the sender starts a new session and re-encrypts; the item is bound to its id and chat", async () => {
        const {secretCrypto} = await load();
        const items = await secretCrypto.encryptRecovery("bob", "chat-1", [{mid: "m1", text: "lost one"}, {mid: "m2", text: "lost two"}]);
        expect(bridge.calls.filter((c) => c === "resetSession").length).toBe(1);
        expect(items.map((i) => i.b.slice(0, 8))).toEqual(["E2EE2:2.", "E2EE2:2."]);   // the new session

        expect(await secretCrypto.decryptRecovery("bob", "chat-1", items)).toEqual([{mid: "m1", text: "lost one"}, {mid: "m2", text: "lost two"}]);
        expect(await secretCrypto.decryptRecovery("bob", "another-chat", items)).toEqual([]);
        expect(await secretCrypto.decryptRecovery("bob", "chat-1", [{...items[0], mid: "m2"}])).toEqual([]);
        // an ordinary message passed off as a recovered one
        const plain = await secretCrypto.encrypt("bob", "just a message");
        expect(await secretCrypto.decryptRecovery("bob", "chat-1", [{mid: "m1", t: 0, b: plain}])).toEqual([]);

        // a second request right away does not reset the session again (a forged request costs one fetch)
        await secretCrypto.encryptRecovery("bob", "chat-1", [{mid: "m3", text: "x"}]);
        expect(bridge.calls.filter((c) => c === "resetSession").length).toBe(1);
    });

    it("sign-out: the app erases its keys; a failure or a slow app never holds the logout up", async () => {
        const {removeFromKeyDirectory} = await import("../lib/wipe.ts");
        bridge.peer("bob").trust = "verified";
        await removeFromKeyDirectory();
        expect(bridge.calls).toContain("wipe");
        expect(bridge.peer("bob").trust).toBe("unverified");   // the mark went with the keys

        bridge.plugin.e2eeWipe.mockRejectedValueOnce(Object.assign(new Error("not implemented"), {code: "UNIMPLEMENTED"}));   // an older app
        await expect(removeFromKeyDirectory()).resolves.toBeUndefined();

        vi.useFakeTimers();
        try {
            bridge.plugin.e2eeWipe.mockImplementationOnce(() => new Promise<void>(() => { /* never answers */ }));
            const done = removeFromKeyDirectory();
            await vi.advanceTimersByTimeAsync(6_000);
            await expect(done).resolves.toBeUndefined();
        } finally { vi.useRealTimers(); }
    });

    it("6.8 — the first start with the bridge erases the interface's own keys and marks, once; texts stay", async () => {
        const {openDB} = await import("idb");
        const {getOwner, setOwner} = await import("../lib/ownerStore.ts");
        const {E2EE_LS} = await import("../lib/stores.ts");
        // what an older version of the interface kept: a peer's key and a session
        const legacy = async <T,>(fn: (d: Awaited<ReturnType<typeof openDB>>) => Promise<T>): Promise<T> => {
            const d = await openDB("e2ee-signal");
            try { return await fn(d); } finally { d.close(); }
        };
        await setOwner("me");
        await legacy(async (d) => {
            await d.put("peers", new Uint8Array([1, 2, 3]).buffer, "bob.1");
            await d.put("sessions", {kind: "native", blob: "AA=="}, "bob.1");
            await d.put("meta", "device-A", "deviceId");
        });
        localStorage.setItem(E2EE_LS.verified, '{"bob":"123"}');
        localStorage.setItem(E2EE_LS.secretChats, '{"c1":true}');

        const {dropInterfaceKeys, E2EE_NATIVE_KEYS_KEY} = await import("../lib/wipe.ts");
        await dropInterfaceKeys();
        expect(await legacy((d) => d.get("peers", "bob.1"))).toBeUndefined();
        expect(await legacy((d) => d.get("sessions", "bob.1"))).toBeUndefined();
        expect(await legacy((d) => d.get("meta", "deviceId"))).toBeUndefined();
        expect(await getOwner()).toBe("me");                                     // whose data this is — kept
        expect(localStorage.getItem(E2EE_LS.verified)).toBeNull();
        expect(localStorage.getItem(E2EE_LS.secretChats)).toBe('{"c1":true}');   // which chats are secret — kept
        expect(localStorage.getItem(E2EE_NATIVE_KEYS_KEY)).toBe("1");

        await legacy((d) => d.put("peers", new Uint8Array([9]).buffer, "carol.1"));
        await dropInterfaceKeys();                                               // already done: nothing is touched
        expect(await legacy((d) => d.get("peers", "carol.1"))).toBeDefined();
    });
});
