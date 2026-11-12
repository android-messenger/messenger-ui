import {describe, it, expect, vi} from "vitest";
import {render, fireEvent} from "@testing-library/react";

// Mutable call state the mocked useSelector reads (hoisted for the vi.mock factory).
const h = vi.hoisted(() => ({status: "ringing" as string, peerId: "peerA" as string | null, audioOnly: false}));

vi.mock("react-i18next", () => ({useTranslation: () => ({t: (k: string) => k})}));
vi.mock("react-redux", () => ({
    useSelector: (sel: (s: unknown) => unknown) => sel({call: {status: h.status, peerId: h.peerId, audioOnly: h.audioOnly}}),
}));
vi.mock("@/features/directory", () => ({
    useGetIdsUserQuery: () => ({data: undefined}),
    idsDisplayName: (u: {id?: string}) => u?.id ?? "",
}));
vi.mock("@/features/e2ee", () => ({
    computeSafetyNumber: vi.fn(async () => null),
    isVerified: vi.fn(() => false),
}));
vi.mock("@/shared/ui/ConfirmModal.jsx", () => ({
    default: ({confirmText, cancelText, onConfirm, onCancel}: {confirmText: string; cancelText: string; onConfirm: () => void; onCancel: () => void}) => (
        <div data-testid="incoming-dialog">
            <button onClick={onConfirm}>{confirmText}</button>
            <button onClick={onCancel}>{cancelText}</button>
        </div>
    ),
}));

import VideoCall from "../VideoCall";

const renderCall = () => render(
    <VideoCall localStream={null} remoteStream={null} onHangUp={vi.fn()} acceptCall={vi.fn()} rejectCall={vi.fn()}/>,
);

describe("VideoCall — incoming Accept/Reject dialog", () => {
    it("shows the dialog whenever status is 'ringing'", () => {
        h.status = "ringing"; h.peerId = "peerA";
        expect(renderCall().queryByTestId("incoming-dialog")).toBeTruthy();
    });

    it("does NOT show the dialog once accepted (status 'connecting')", () => {
        h.status = "connecting";
        expect(renderCall().queryByTestId("incoming-dialog")).toBeNull();
    });

    it("dialog is a pure function of status — stays shown on a re-ring in the SAME mounted instance", () => {
        // The regression: the dialog was gated behind a local `newCall` flag flipped false on accept and
        // reset only on mount. If two calls batched so the component never remounted, the 2nd ring showed
        // NO dialog. Simulate: ring → accept (flag would flip) → still ringing (no remount) → must STILL show.
        h.status = "ringing"; h.peerId = "peerA";
        const {queryByTestId, getByText, rerender} = renderCall();
        expect(queryByTestId("incoming-dialog")).toBeTruthy();
        fireEvent.click(getByText("call.accept"));   // old code: setNewCall(false)
        h.status = "ringing";                         // a fresh ring arrived; status never rendered as idle
        rerender(<VideoCall localStream={null} remoteStream={null} onHangUp={vi.fn()} acceptCall={vi.fn()} rejectCall={vi.fn()}/>);
        expect(queryByTestId("incoming-dialog")).toBeTruthy();  // must still show (was the bug)
    });
});
