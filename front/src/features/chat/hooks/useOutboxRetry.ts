import {useEffect} from "react";
import {useDispatch} from "react-redux";
import type {AppDispatch} from "@/store/store";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";
import {OUTBOX_RETRY_TICK_MS} from "@/shared/config/outbox.ts";

// Periodic retry driver for the outbox: re-runs flushOutbox on a fixed cadence so a message that
// was sent but never ACKed (packet lost on a live connection, not just across reconnects) gets
// resent after OUTBOX_RETRY_ACK_TIMEOUT_MS. flushOutbox is a cheap no-op when disconnected or when
// nothing is due, so the ticker is safe to run for the app's lifetime.
export function useOutboxRetry() {
    const dispatch = useDispatch<AppDispatch>();
    useEffect(() => {
        const t = setInterval(() => dispatch(flushOutbox()), OUTBOX_RETRY_TICK_MS);
        return () => clearInterval(t);
    }, [dispatch]);
}
