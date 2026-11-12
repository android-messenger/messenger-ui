import {beforeEach, describe, expect, it, vi} from "vitest";

// The five operations over the browser implementation: they must behave exactly as the functions they wrap.
const h = vi.hoisted(() => ({
    owner: "me" as string | undefined,
    encryptForSend: vi.fn(async (_p: string, t: string) => "E2EE1:" + t),
    decryptReceived: vi.fn(async (_p: string, b: string) => b.slice(6)),
    computeSafetyNumber: vi.fn(async (me: string, peer: string) => `${me}|${peer}` as string | null),
}));
vi.mock("../lib/secretChat.ts", () => ({encryptForSend: h.encryptForSend, decryptReceived: h.decryptReceived}));
vi.mock("../lib/provisioning.ts", () => ({ensureProvisioned: async () => ({store: {getOwner: async () => h.owner}})}));
vi.mock("../lib/safetyNumber.ts", async (orig) => ({
    ...(await orig<typeof import("../lib/safetyNumber.ts")>()),
    computeSafetyNumber: h.computeSafetyNumber,
}));

import {secretCrypto} from "../crypto.ts";

describe("secretCrypto (browser implementation)", () => {
    beforeEach(() => {
        localStorage.clear();
        h.owner = "me";
        h.computeSafetyNumber.mockImplementation(async (me, peer) => `${me}|${peer}`);
    });

    it("encrypt and decrypt pass through to the session code, errors included", async () => {
        expect(await secretCrypto.encrypt("bob", "hi")).toBe("E2EE1:hi");
        expect(await secretCrypto.decrypt("bob", "E2EE1:hi")).toBe("hi");
        h.encryptForSend.mockRejectedValueOnce(new Error("NO_PEER_KEYS"));
        await expect(secretCrypto.encrypt("bob", "hi")).rejects.toThrow("NO_PEER_KEYS");
    });

    it("the safety number is computed for the owner of the keys on this device", async () => {
        expect(await secretCrypto.safetyNumber("bob")).toBe("me|bob");
        h.owner = undefined;
        expect(await secretCrypto.safetyNumber("bob")).toBeNull();
    });

    it("a peer is verified only after setVerified, and until the number changes", async () => {
        expect(await secretCrypto.peerState("bob")).toEqual({trust: "unverified", keyChanged: false});
        await secretCrypto.setVerified("bob", true);
        expect((await secretCrypto.peerState("bob")).trust).toBe("verified");
        expect((await secretCrypto.peerState("carol")).trust).toBe("unverified");

        h.computeSafetyNumber.mockImplementation(async () => "another key");
        expect((await secretCrypto.peerState("bob")).trust).toBe("unverified");
    });

    it("setVerified(false) takes the mark off", async () => {
        await secretCrypto.setVerified("bob", true);
        await secretCrypto.setVerified("bob", false);
        expect((await secretCrypto.peerState("bob")).trust).toBe("unverified");
    });

    it("a peer whose key is not known cannot be marked verified", async () => {
        h.computeSafetyNumber.mockImplementation(async () => null);
        await expect(secretCrypto.setVerified("bob", true)).rejects.toThrow();
        expect((await secretCrypto.peerState("bob")).trust).toBe("unverified");
    });
});
