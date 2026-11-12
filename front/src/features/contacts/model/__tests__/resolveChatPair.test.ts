import {describe, it, expect} from "vitest";
import {resolveChatPair} from "../resolveChatPair";

const A = "aaaa-1111"; // sorts before B
const B = "bbbb-2222";

describe("resolveChatPair", () => {
    it("orders the pair by id", () => {
        expect(resolveChatPair(A, B)).toEqual({clientId: A, masterId: B});
    });

    it("is direction-independent: both participants compute the SAME tuple", () => {
        expect(resolveChatPair(B, A)).toEqual(resolveChatPair(A, B));
    });
});
