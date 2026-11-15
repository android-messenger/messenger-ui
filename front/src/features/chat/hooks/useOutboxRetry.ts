import {useEffect} from "react";
import {useDispatch} from "react-redux";
import type {AppDispatch} from "@/store/store";
import {flushOutbox} from "@/features/chat/thunk/sendOutboxThunk.ts";
import {OUTBOX_RETRY_TICK_MS} from "@/shared/config/outbox.ts";

// Looks at the send queue on a timer: a message sent over a living connection and not confirmed within
// OUTBOX_SEND_TIMEOUT_MS becomes "not sent". Nothing is sent a second time over the same connection
// (sendOutboxThunk). flushOutbox does nothing when there is no connection or nothing is due.
export function useOutboxRetry() {
    const dispatch = useDispatch<AppDispatch>();
    useEffect(() => {
        const t = setInterval(() => dispatch(flushOutbox()), OUTBOX_RETRY_TICK_MS);
        return () => clearInterval(t);
    }, [dispatch]);
}
