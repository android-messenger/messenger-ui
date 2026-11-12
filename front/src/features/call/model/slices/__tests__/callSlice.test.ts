import {describe, it, expect} from "vitest";
import reducer, {
    outgoingCall, incomingOffer, acceptCall, incomingAnswer,
    webrtcConnected, incomingRemoteEnd, rejectCall, localEnd,
} from "../callSlice";

const initial = reducer(undefined, {type: "@@INIT"});
const sdp = "ciphertext";

describe("callSlice", () => {
    it("starts idle with audioOnly=false", () => {
        expect(initial).toMatchObject({status: "idle", peerId: null, incomingOfferData: null, audioOnly: false});
    });

    it("outgoingCall → calling + peerId, audioOnly from the payload (default false)", () => {
        expect(reducer(initial, outgoingCall({peerId: "p1", audioOnly: true})))
            .toMatchObject({status: "calling", peerId: "p1", audioOnly: true});
        expect(reducer(initial, outgoingCall({peerId: "p2"})).audioOnly).toBe(false);
    });

    it("incomingOffer → ringing, audioOnly ONLY when media==='audio'", () => {
        const audio = reducer(initial, incomingOffer({from: "a", sdp, media: "audio"}));
        expect(audio).toMatchObject({status: "ringing", peerId: "a", audioOnly: true});
        expect(audio.incomingOfferData).toMatchObject({from: "a", media: "audio"});
        expect(reducer(initial, incomingOffer({from: "b", sdp, media: "video"})).audioOnly).toBe(false);
        expect(reducer(initial, incomingOffer({from: "c", sdp})).audioOnly).toBe(false); // media absent
    });

    it("acceptCall / incomingAnswer → connecting; webrtcConnected → in_call", () => {
        expect(reducer(initial, acceptCall()).status).toBe("connecting");
        expect(reducer(initial, incomingAnswer()).status).toBe("connecting");
        expect(reducer(initial, webrtcConnected()).status).toBe("in_call");
    });

    it.each([
        ["incomingRemoteEnd", incomingRemoteEnd],
        ["rejectCall", rejectCall],
        ["localEnd", localEnd],
    ])("%s resets to idle and clears peerId/offer/audioOnly", (_name, action) => {
        const active = reducer(initial, outgoingCall({peerId: "p", audioOnly: true}));
        expect(reducer(active, action()))
            .toMatchObject({status: "idle", peerId: null, incomingOfferData: null, audioOnly: false});
    });
});
