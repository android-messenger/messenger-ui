import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {render, screen, fireEvent, waitFor} from "@testing-library/react";

// i18n: return the key so assertions are stable.
vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k, i18n: {language: "en"}})}));
// redux: feed a minimal state directly to each selector.
vi.mock("react-redux", () => ({useDispatch: () => () => {}, useSelector: (fn: (s: unknown) => unknown) => fn({user: {id: "u12345678"}, ws: {status: "connected"}})}));
// stats are async IndexedDB reads — stub them out.
vi.mock("@/features/chat/db/db.ts", () => ({mediaStats: async () => ({files: 0, fileBytes: 0, chats: 0, messages: 0})}));
vi.mock("@/features/e2ee", () => ({cryptoStats: async () => ({secretMessages: 0, secretBytes: 0, pendingRecovery: 0, protocol: "signal"})}));
vi.mock("@/shared/diag/diag.ts", () => ({
    appVersion: "0.2.3", buildTime: "", getLoginAt: () => 0, connectsInLast: () => 0, connectBuckets: () => [] as number[],
}));

const order: string[] = [];
const goLogin = vi.fn(() => { order.push("login page"); });
vi.mock("@/features/auth/model/services/fullLogout.ts", () => ({goLoginAfterLogout: () => goLogin()}));
// The erase itself (the device first, then the sign-out, then the rest) is tested in src/__audit__/eraseOrder.
const wipeAllStorage = vi.fn(async () => { order.push("erase"); });
vi.mock("../eraseEverything.ts", () => ({eraseEverything: () => wipeAllStorage()}));

const pwa = {canInstall: vi.fn(() => false), isStandalone: vi.fn(() => false), promptInstall: vi.fn(async () => true)};
vi.mock("@/shared/pwa/installPrompt.ts", () => ({
    canInstall: () => pwa.canInstall(), isStandalone: () => pwa.isStandalone(), promptInstall: () => pwa.promptInstall(),
}));

import {InfoModal} from "../InfoModal";

beforeEach(() => {
    wipeAllStorage.mockClear(); order.length = 0;
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
        await waitFor(() => expect(goLogin).toHaveBeenCalledTimes(1));
        // erases and signs out, then leaves for the login page
        expect(order).toEqual(["erase", "login page"]);
    });

    it("in the Android app: the APK version and the device certificate are shown, the PWA install block is not", async () => {
        const g = globalThis as {Capacitor?: unknown};
        g.Capacitor = {isNativePlatform: () => true, Plugins: {
            AppSettings: {getAppInfo: async () => ({versionName: "1.0.96-pilot", versionCode: 10096})},
            DeviceTrust: {
                getState: async () => ({state: "ACTIVE", notAfter: "2026-11-16T10:00:00Z"}),
                getDeviceInfo: async () => ({securityLevel: "TEE", strongBox: false, sdkInt: 34, securityPatch: "2026-10-01"}),
            },
        }};
        try {
            render(<InfoModal onClose={() => {}}/>);
            await waitFor(() => expect(screen.getByText("1.0.96-pilot (10096)")).toBeTruthy());
            expect(screen.getByText("ACTIVE")).toBeTruthy();
            expect(screen.getByText("TEE")).toBeTruthy();
            expect(screen.queryByText("0.2.3")).toBeNull();
            expect(screen.queryByText("info.installHintIos")).toBeNull();
        } finally { delete g.Capacitor; }
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
