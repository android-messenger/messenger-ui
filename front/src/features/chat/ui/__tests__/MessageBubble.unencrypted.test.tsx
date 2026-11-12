import {describe, it, expect, vi} from "vitest";
import {render} from "@testing-library/react";
import {MessageBubble, type ChatMessageView} from "../MessageBubble";

vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));
vi.mock("../AttachmentImage.tsx", () => ({AttachmentImage: () => <span>img</span>}));

const msg = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({
    id: "01KY29D4BHHB40EW2FKMHR6V7M", text: "hi", fromMe: false, createdAt: 1_700_000_000_000, ...over,
});
const bubble = (props: Partial<Parameters<typeof MessageBubble>[0]>) =>
    render(<MessageBubble msg={msg()} bubbleMt="mt-3" peerLastReadId="" {...props} />).container;

// Spec 001, story 4, scenario 4.
describe("MessageBubble: a clear message in a secret chat", () => {
    it("carries the 'not encrypted' mark", () => {
        const c = bubble({unencrypted: true});
        expect(c.querySelector("[data-testid=not-encrypted]")?.textContent).toContain("chat.notEncrypted");
    });

    it("an ordinary message has no mark", () => {
        expect(bubble({}).querySelector("[data-testid=not-encrypted]")).toBeNull();
    });

    it("an encrypted message never carries it", () => {
        const c = bubble({msg: msg({secret: true}), unencrypted: true});
        expect(c.querySelector("[data-testid=not-encrypted]")).toBeNull();
        expect(c.textContent).toContain("🔒");
    });
});

// Spec 001, story 5, finding 46.
describe("MessageBubble: a secret message that could not be stored on the device", () => {
    it("carries the 'not saved' mark", () => {
        const c = bubble({msg: msg({secret: true, unsaved: true})});
        expect(c.querySelector("[data-testid=not-saved]")?.textContent).toContain("chat.notSaved");
    });

    it("a stored message has no mark", () => {
        expect(bubble({msg: msg({secret: true})}).querySelector("[data-testid=not-saved]")).toBeNull();
    });
});
