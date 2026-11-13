import {useEffect} from "react";
import {useSelector} from "react-redux";
import type {RootState} from "@/store/store.ts";
import {startRinging, stopRinging} from "@/shared/sound/notify.ts";
import {callPlugin, isNativeApp} from "@/shared/platform.ts";

/** The app's own ringback tone, on or off. Best-effort: an APK without it stays silent. */
function nativeRingback(on: boolean): void {
    try { callPlugin().ringback({on}).catch(() => { /* an older APK */ }); } catch { /* no plugin */ }
}

/**
 * Play the looping ringtone while a call is inbound-ringing (someone is calling me) or outbound-calling
 * (ringback while I dial), and stop it once the call connects, ends, or is declined.
 *
 * In the Android app the ringback of an OUTGOING call is played by the app, not here: the app takes the
 * audio for the call the moment the call starts, the system then pauses the page's player — silence while
 * dialling — and lets it go on when the call is dropped — a tone with no call (owner's report, 10098).
 */
export function useCallRingtone() {
    const status = useSelector((s: RootState) => s.call.status);
    useEffect(() => {
        const native = isNativeApp();
        if (native && status === "calling") {
            nativeRingback(true);
            return () => nativeRingback(false);
        }
        if (status === "ringing" || status === "calling") startRinging();
        else stopRinging();
        return () => stopRinging();
    }, [status]);
}
