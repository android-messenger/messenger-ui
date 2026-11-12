import {useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject} from "react";
import {useDispatch} from "react-redux";
import type {AppDispatch} from "@/store/store";
import {loadOlderHistory} from "@/features/chat/thunk/loadOlderHistory.ts";
import {MESSAGE_WINDOW_INITIAL, MESSAGE_WINDOW_STEP} from "@/shared/config/chat.ts";

/**
 * Windowed history + "show earlier", extracted verbatim from ChatWindow. Keeps only the most recent
 * `visibleCount` messages in the DOM (a long history doesn't reconcile hundreds of bubbles); "show
 * earlier" first reveals in-memory older messages, then pulls an older server page (`?before=`). The
 * window resets to the tail when the chat changes. After older rows render at the top, the viewport is
 * restored to the same distance from the bottom (no jump) — hence `listRef` is passed in.
 */
export function useWindowedHistory<T>(
    messages: T[],
    selectedChatId: string | null,
    listRef: RefObject<HTMLDivElement | null>,
) {
    const dispatch = useDispatch<AppDispatch>();
    const [visibleCount, setVisibleCount] = useState(MESSAGE_WINDOW_INITIAL);
    // reachedStart: the server has no older page (loadOlderHistory returned 0). loadingOlder: a network
    // fetch is in flight. anchorRef: distance-from-bottom captured before revealing/loading older, so the
    // viewport can be restored after the taller list renders.
    const [reachedStart, setReachedStart] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const anchorRef = useRef<number | null>(null);

    // Reset to the tail when the chat changes — during render (React's recommended "adjust state on
    // prop change" pattern), not in an effect, so the new chat's first paint already shows its tail
    // window with no stale-window flash and no extra commit.
    const [prevChatId, setPrevChatId] = useState(selectedChatId);
    if (selectedChatId !== prevChatId) {
        setPrevChatId(selectedChatId);
        setVisibleCount(MESSAGE_WINDOW_INITIAL);
        setReachedStart(false);
    }

    const shown = useMemo(
        () => (messages.length > visibleCount ? messages.slice(messages.length - visibleCount) : messages),
        [messages, visibleCount],
    );
    // More to reveal: older messages already in memory, or the server may have more.
    const hasEarlierInMemory = messages.length > visibleCount;
    const hasEarlier = hasEarlierInMemory || !reachedStart;

    // "Show earlier": reveal in-memory older messages first (windowing); once those run out, pull an
    // older page (`?before=`) and reveal it too. Capture the scroll anchor first.
    const showEarlier = useCallback(async () => {
        if (loadingOlder) return;
        const el = listRef.current;
        anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
        if (hasEarlierInMemory) {
            setVisibleCount((c) => c + MESSAGE_WINDOW_STEP);
            return;
        }
        if (reachedStart || !selectedChatId) return;
        setLoadingOlder(true);
        try {
            const n = await dispatch(loadOlderHistory(selectedChatId));
            if (!n) setReachedStart(true);
            else setVisibleCount((c) => c + n); // reveal the freshly-prepended older messages
        } finally {
            setLoadingOlder(false);
        }
    }, [loadingOlder, hasEarlierInMemory, reachedStart, selectedChatId, dispatch, listRef]);

    // Restore the viewport after older messages render at the top: keep the same distance from the
    // bottom so the content the user was reading stays put (no jump).
    useLayoutEffect(() => {
        if (anchorRef.current == null) return;
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight - anchorRef.current;
        anchorRef.current = null;
    }, [shown.length, listRef]);

    return {shown, hasEarlier, showEarlier, loadingOlder};
}
