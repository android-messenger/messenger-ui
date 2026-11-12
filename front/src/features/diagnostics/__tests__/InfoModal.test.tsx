import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {render, screen, fireEvent, waitFor} from "@testing-library/react";

// i18n: return the key so assertions are stable.
vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k, i18n: {language: "en"}})}));
// redux: feed a minimal state directly to each selector.
vi.mock("react-redux", () => ({useSelector: (fn: (s: unknown) => unknown) => fn({user: {id: "u12345678"}, ws: {status: "connected"}})}));
// stats are async IndexedDB reads — stub them out.
vi.mock("@/features/chat/db/db.ts", () => ({mediaStats: async () => ({files: 0, fileBytes: 0, chats: 0, messages: 0})}));
vi.mock("@/features/e2ee", () => ({cryptoStats: async () => ({deviceKeyCreatedAt: 0, secretMessages: 0, secretBytes: 0, pendingRecovery: 0, verifiedContacts: 0, protocol: "signal", lib: "x", envelope: 1})}));
vi.mock("@/shared/diag/diag.ts", () => ({
    appVersion: "0.2.3", buildTime: "", getLoginAt: () => 0, connectsInLast: () => 0, connectBuckets: () => [] as number[],
}));

const wipeAllStorage = vi.fn(async () => {});
vi.mock("../wipeStorage.ts", () => ({wipeAllStorage: () => wipeAllStorage()}));

const pwa = {canInstall: vi.fn(() => false), isStandalone: vi.fn(() => false), promptInstall: vi.fn(async () => true)};
vi.mock("@/shared/pwa/installPrompt.ts", () => ({
    canInstall: () => pwa.canInstall(), isStandalone: () => pwa.isStandalone(), promptInstall: () => pwa.promptInstall(),
}));

import {InfoModal} from "../InfoModal";

beforeEach(() => {
    wipeAllStorage.mockClear();
    pwa.canInstall.mockReturnValue(false); pwa.isStandalone.mockReturnValue(false); pwa.promptInstall.mockClear();
    // Neutralize the hard reload doWipe triggers.
    Object.defineProperty(window, "location", {configurable: true, value: {...window.location, reload: vi.fn()}});
});
afterEach(() => vi.clearAllMocks());

describe("InfoModal — install + wipe", () => {
    it("wipe is two-step: the button reveals a confirm, and only confirming wipes", async () => {
        render(<InfoModal onClose={() => {}}/>);
        // First click just reveals the confirmation — nothing wiped yet.
        fireEvent.click(screen.getByText("info.wipe"));
        expect(screen.getByText("info.wipeDesc")).toBeTruthy();
        expect(wipeAllStorage).not.toHaveBeenCalled();
        // Confirm → wipe runs.
        fireEvent.click(screen.getByText("info.wipeConfirm"));
        await waitFor(() => expect(wipeAllStorage).toHaveBeenCalledTimes(1));
    });

    it("cancel backs out of the confirm without wiping", () => {
        render(<InfoModal onClose={() => {}}/>);
        fireEvent.click(screen.getByText("info.wipe"));
        fireEvent.click(screen.getByText("info.cancel"));
        expect(screen.queryByText("info.wipeDesc")).toBeNull();
        expect(wipeAllStorage).not.toHaveBeenCalled();
    });

    it("shows a native Install button when installable, and clicking prompts", () => {
        pwa.canInstall.mockReturnValue(true);
        render(<InfoModal onClose={() => {}}/>);
        fireEvent.click(screen.getByText("info.installBtn"));
        expect(pwa.promptInstall).toHaveBeenCalledTimes(1);
    });

    it("shows install hints when not installable", () => {
        render(<InfoModal onClose={() => {}}/>);
        expect(screen.getByText("info.installHintIos")).toBeTruthy();
        expect(screen.getByText("info.installHintOther")).toBeTruthy();
    });

    it("shows the installed state when running standalone", () => {
        pwa.isStandalone.mockReturnValue(true);
        render(<InfoModal onClose={() => {}}/>);
        expect(screen.getByText(/info.installed/)).toBeTruthy();
        expect(screen.queryByText("info.installBtn")).toBeNull();
    });
});
