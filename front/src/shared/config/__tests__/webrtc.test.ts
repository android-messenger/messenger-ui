import {describe, it, expect} from "vitest";
import {stunServers} from "../webrtc";
import webrtcSource from "../webrtc.ts?raw";

// Spec 001, story 5, finding 50: the code carried a default STUN address — somebody else's server.
describe("STUN/TURN server address", () => {
    it("is built only from the values the build provides", () => {
        expect(stunServers("turn.example.test", "3480")).toEqual([{urls: "stun:turn.example.test:3480"}]);
    });

    it("no STUN entry when the address is not set", () => {
        expect(stunServers("", "")).toEqual([]);
        expect(stunServers("turn.example.test", "")).toEqual([]);
    });

    it("the source has no address literal and no default value", () => {
        expect(webrtcSource).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
        expect(webrtcSource).not.toMatch(/\?\?\s*"/);
    });
});
