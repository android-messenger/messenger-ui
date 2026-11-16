// What the user sees (spec 003, FR-050): one place for "the page is on the screen" and for "the user is
// looking at this chat". The middleware (read or mark a socket message), the unread probe, the read
// receipts and the catch-up after a return to the screen ask here.

/** The page is not on the screen: another tab, the app in the background, the screen off. */
export function pageHidden(): boolean {
    return typeof document !== "undefined" && (document.hidden || document.visibilityState === "hidden");
}

/** The chat the user is looking at: the one selected, while the page is on the screen; else null. */
export function chatOnScreen(selectedChatId: string | null | undefined): string | null {
    return pageHidden() ? null : selectedChatId ?? null;
}
