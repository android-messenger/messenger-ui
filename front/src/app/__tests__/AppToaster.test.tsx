import {describe, it, expect, afterEach, beforeAll} from "vitest";
import {render, screen, fireEvent, waitFor, act, cleanup} from "@testing-library/react";
import toast from "react-hot-toast";
import {AppToaster} from "../AppToaster";

// jsdom has no matchMedia; the library asks it about reduced motion.
beforeAll(() => { window.matchMedia = (() => ({matches: true, addEventListener() {}, removeEventListener() {}})) as never; });
afterEach(() => { act(() => toast.remove()); cleanup(); });

describe("AppToaster", () => {
    it("keeps toasts below the status bar", () => {
        const {container} = render(<AppToaster/>);
        expect((container.firstChild as HTMLElement).style.top).toContain("--wolp-sat");
    });

    it("a touch closes a toast instead of pausing it for good", async () => {
        render(<AppToaster/>);
        act(() => { toast.error("cannot send"); });
        const shown = await screen.findByText("cannot send");
        const box = shown.closest('[data-testid="toast"]') as HTMLElement;
        fireEvent.mouseEnter(box.parentElement!.parentElement!);   // what a finger does first: the library pauses
        fireEvent.touchEnd(box);
        await waitFor(() => expect(document.querySelector('[data-testid="toast"]')).toBeNull(), {timeout: 3000});
    });
});
