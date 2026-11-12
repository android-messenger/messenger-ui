import {useEffect} from "react";
import {useSelector} from "react-redux";
import type {RootState} from "@/store/store.ts";
import {startRinging, stopRinging} from "@/shared/sound/notify.ts";

/**
 * Play the looping ringtone while a call is inbound-ringing (someone is calling me) or outbound-calling
 * (ringback while I dial), and stop it once the call connects, ends, or is declined. Best-effort: the
 * ring is WebAudio and needs the AudioContext unlocked by a prior user gesture (see App).
 */
export function useCallRingtone() {
    const status = useSelector((s: RootState) => s.call.status);
    useEffect(() => {
        if (status === "ringing" || status === "calling") startRinging();
        else stopRinging();
        return () => stopRinging();
    }, [status]);
}
