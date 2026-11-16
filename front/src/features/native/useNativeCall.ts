// Android app glue for calls (S1 §4.5, §5.3, §7.3). Part of the lazily loaded NativeAppBridge chunk.
//   - a call in progress (calling / connecting / in_call) → Call.started(): the native foreground
//     service keeps the microphone, camera and WebSocket alive when the app is minimised; idle → ended();
//   - hangupFromNotification («Завершить» in the ongoing-call notification) → localEnd;
//   - callDecline (the native incoming screen was declined while our WebSocket may be open) → our own
//     call:end to the caller, exactly what rejecting the in-app dialog sends;
//   - audioFocusLost (a GSM call or another app took the audio) → a toast.
import {useEffect} from "react";
import {useDispatch, useSelector, useStore} from "react-redux";
import toast from "react-hot-toast";
import type {RootState} from "@/store/store.ts";
import {callPlugin, removeListener, type PluginListenerHandle} from "@/shared/platform.ts";
import {localEnd} from "@/features/call/model/slices/callSlice";
import {selectCallConversationId} from "@/features/chat/model/directDirectory.ts";
import {selectUserName} from "@/features/directory";
import {logger} from "@/shared/logger/logger.ts";
import i18n from "@/shared/i18n";

type CallStatus = RootState["call"]["status"];

/** A call that needs the native call service (exported for tests). */
export function isActiveCall(status: CallStatus): boolean {
    return status === "calling" || status === "connecting" || status === "in_call";
}

/** The SIGNAL frame of a decline from the native screen (exported for tests). */
export function declineFrame(d: { conversationId: string; callerId: string }) {
    return {type: "call:end", to: d.callerId, conversationId: d.conversationId};
}

export function useNativeCall() {
    const dispatch = useDispatch();
    const store = useStore<RootState>();
    const active = useSelector((s: RootState) => isActiveCall(s.call.status));

    useEffect(() => {
        if (!active) return;
        const state = store.getState();
        const {peerId, audioOnly} = state.call;
        const conversationId = state.call.conversationId
            ?? (peerId ? selectCallConversationId(state, peerId) : undefined)
            ?? peerId ?? "call";
        const peerName = peerId ? selectUserName(state, peerId) : undefined;
        callPlugin().started({media: audioOnly ? "audio" : "video", conversationId, peerName})
            .catch((e) => logger.warn("call: native call service not started", e as Error));
        return () => { callPlugin().ended().catch(() => { /* the service stops itself 10 s after the WebView anyway */ }); };
    }, [active, store]);

    useEffect(() => {
        const p = callPlugin();
        const handles: Promise<PluginListenerHandle>[] = [
            p.addListener("hangupFromNotification", () => {
                if (store.getState().call.status !== "idle") dispatch(localEnd());
            }),
            p.addListener("callDecline", (d) => {
                logger.debug("call: declined on the native screen, sending call:end");
                dispatch({type: "ws/send", payload: declineFrame(d)});
            }),
            p.addListener("audioFocusLost", () => {
                toast(i18n.t("call.audioFocusLost"));
            }),
        ];
        return () => handles.forEach(removeListener);
    }, [dispatch, store]);
}
