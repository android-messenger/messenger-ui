import {describe, it, expect, vi, beforeEach} from "vitest";
import {render, fireEvent, waitFor} from "@testing-library/react";

// Mutable "open chat" so we can simulate navigating between chats (hoisted for the vi.mock factory).
const h = vi.hoisted(() => ({chat: "chatA" as string | null}));

vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));
vi.mock("react-redux", () => ({useSelector: (sel: (s: unknown) => unknown) => sel({chatUi: {selectedChatId: h.chat}})}));
// Poster load is a cheap local IndexedDB read — stub it so no cached poster exists (generic placeholder).
vi.mock("@/features/chat/db/db.ts", () => ({
    loadAttachmentBlob: () => Promise.resolve(null),
    saveAttachmentBlob: () => Promise.resolve(),
}));

import {AttachmentVideo} from "../AttachmentVideo";

const el = (chat: string | null = h.chat) => {
    h.chat = chat;
    return <AttachmentVideo attachmentId="a1" fileName="v.webm" resolveUrl={() => Promise.resolve("blob:fake")}/>;
};

describe("AttachmentVideo — click-to-play + stop-on-navigation", () => {
    beforeEach(() => { h.chat = "chatA"; });

    it("shows a poster/play button and NO <video> until tapped (chat open doesn't stream)", () => {
        const {container} = render(el());
        expect(container.querySelector("video")).toBeNull();
        expect(container.querySelector("button")).toBeTruthy();
    });

    it("mounts <video> on tap, then UNMOUNTS it when the open chat changes (no auto-play on re-entry)", async () => {
        const {container, rerender} = render(el("chatA"));
        fireEvent.click(container.querySelector("button")!);
        await waitFor(() => expect(container.querySelector("video")).toBeTruthy());

        // Navigate away (another chat / the list) → selectedChatId changes → playing resets → <video> gone.
        rerender(el("chatB"));
        await waitFor(() => expect(container.querySelector("video")).toBeNull());
        expect(container.querySelector("button")).toBeTruthy();
    });
});
