import {describe, it, expect} from "vitest";
import {KRATOS_ADDRESS_NOT_VERIFIED, loginMessageText} from "@/features/auth/model/loginMessages.ts";

const t = (k: string) => `t:${k}`;

describe("login flow messages", () => {
    it("explains an unverified address", () => {
        expect(loginMessageText({id: KRATOS_ADDRESS_NOT_VERIFIED, text: "Account not active yet."}, t)).toBe("t:auth.verifyEmailFirst");
    });
    it("keeps other Kratos messages", () => {
        expect(loginMessageText({id: 4000006, text: "The provided credentials are invalid"}, t)).toBe("The provided credentials are invalid");
    });
});
