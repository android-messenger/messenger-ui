import {useEffect, useRef} from "react";
import {useDispatch, useSelector} from "react-redux";
import toast from "react-hot-toast";
import i18n from "@/shared/i18n";
import type {AppDispatch, RootState} from "@/store/store";
import {localEnd, rejectCall} from "@/features/call/model/slices/callSlice";
import {CALL_TIMEOUT_MS} from "@/shared/config/webrtc";

// Auto-ends a call that hangs in a non-terminal state past CALL_TIMEOUT_MS:
//  - OUTGOING (calling/connecting) → give up so the caller isn't on a black screen forever;
//  - INCOMING (ringing) → auto-decline a missed call. Crucial: without this a ring whose call:end never
//    arrived stays "ringing" forever, wedging the state machine so the NEXT incoming call is mis-handled
//    (declined/ignored instead of ringing). rejectCall tells the caller (sends call:end).
export function useCallTimeout() {
    const dispatch = useDispatch<AppDispatch>();
    const status = useSelector((s: RootState) => s.call.status);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        if (status === "calling" || status === "connecting") {
            timer.current = setTimeout(() => {
                toast.error(i18n.t("call.noAnswer"));
                dispatch(localEnd());
            }, CALL_TIMEOUT_MS);
        } else if (status === "ringing") {
            timer.current = setTimeout(() => { dispatch(rejectCall()); }, CALL_TIMEOUT_MS);
        }
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [status, dispatch]);
}
