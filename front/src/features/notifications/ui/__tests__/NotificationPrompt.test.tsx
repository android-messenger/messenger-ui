import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {render, screen, fireEvent, waitFor} from "@testing-library/react";

// i18n: return the key so assertions are stable.
vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));

// Force Web Push "supported" and spy on the subscribe call.
const ensurePushSubscription = vi.fn();
vi.mock("@/features/notifications/push.ts", () => ({
    pushSupported: () => true,
    ensurePushSubscription: () => ensurePushSubscription(),
}));

import {NotificationPrompt} from "../NotificationPrompt";

function setPermission(p: NotificationPermission, requestResult: NotificationPermission = "granted") {
    // @ts-expect-error minimal Notification stub for jsdom
    globalThis.Notification = {
        permission: p,
        requestPermission: vi.fn(() => Promise.resolve(requestResult)),
    };
}

describe("NotificationPrompt", () => {
    beforeEach(() => { localStorage.clear(); ensurePushSubscription.mockClear(); });
    afterEach(() => { // @ts-expect-error cleanup stub
        delete globalThis.Notification; });

    it("shows the enable banner when permission is default", () => {
        setPermission("default");
        render(<NotificationPrompt/>);
        expect(screen.getByText("notify.enablePrompt")).toBeTruthy();
        expect(screen.getByText("notify.enable")).toBeTruthy();
    });

    it("renders nothing when permission is already granted", () => {
        setPermission("granted");
        const {container} = render(<NotificationPrompt/>);
        expect(container.firstChild).toBeNull();
    });

    it("renders nothing when permission is denied", () => {
        setPermission("denied");
        const {container} = render(<NotificationPrompt/>);
        expect(container.firstChild).toBeNull();
    });

    it("requests permission and subscribes on Enable (granted)", async () => {
        setPermission("default", "granted");
        render(<NotificationPrompt/>);
        fireEvent.click(screen.getByText("notify.enable"));
        expect((globalThis.Notification.requestPermission as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
        await waitFor(() => expect(ensurePushSubscription).toHaveBeenCalled());
    });

    it("does not subscribe when the user denies at the OS prompt", async () => {
        setPermission("default", "denied");
        render(<NotificationPrompt/>);
        fireEvent.click(screen.getByText("notify.enable"));
        await Promise.resolve();
        expect(ensurePushSubscription).not.toHaveBeenCalled();
    });

    it("stays hidden after dismiss (persisted)", () => {
        setPermission("default");
        const {container, unmount} = render(<NotificationPrompt/>);
        fireEvent.click(screen.getByText("notify.later"));
        expect(container.firstChild).toBeNull();
        unmount();
        // re-mount: still hidden
        const {container: c2} = render(<NotificationPrompt/>);
        expect(c2.firstChild).toBeNull();
    });
});
