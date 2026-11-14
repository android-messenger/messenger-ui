// Android app glue (S1 §6, §7.0): mounted only when isNativeApp(), lazily, so the browser bundle never
// loads it. Wires the `Push` plugin to the store and the router:
//   - appBackground → close the WebSocket, suppress reconnects, answer wsClosed;
//   - appForeground → reconnect;
//   - notificationTap → open the conversation, or the call deep link (?call=…&caller=…);
//   - the open conversation → setForegroundConversation (no notification for it);
//   - calls → the `Call` plugin (useNativeCall, S1 §4.5, §7.3).
import {useEffect} from "react";
import {useDispatch, useSelector, useStore} from "react-redux";
import {useNavigate} from "react-router-dom";
import type {RootState} from "@/store/store.ts";
import {push, removeListener, type PluginListenerHandle} from "@/shared/platform.ts";
import {messengerWsUrl} from "@/shared/config/api.ts";
import {isNotLogged} from "@/shared/utils/checks.ts";
import {logger} from "@/shared/logger/logger.ts";
import {setAppBackgrounded} from "./appLifecycle.ts";
import {tapRoute} from "./tapRoute.ts";
import {noteNativeAccept} from "@/features/call/model/nativeAccept.ts";
import {useNativeCall} from "./useNativeCall.ts";
import {markStale} from "@/features/chat/model/historySync.ts";

export default function NativeAppBridge() {
    const dispatch = useDispatch();
    const store = useStore<RootState>();
    const navigate = useNavigate();
    const selectedChatId = useSelector((s: RootState) => s.chatUi.selectedChatId);
    useNativeCall();

    useEffect(() => {
        const handles: Promise<PluginListenerHandle>[] = [];
        const p = push();
        handles.push(p.addListener("appBackground", () => {
            setAppBackgrounded(true);
            dispatch({type: "ws/disconnect"});
            logger.debug("app background: WebSocket closed");
            p.wsClosed().catch(() => { /* the native side parks the WebView after 3 s anyway */ });
        }));
        handles.push(p.addListener("appForeground", () => {
            setAppBackgrounded(false);
            if (isNotLogged(store.getState().user.id)) return;
            dispatch({type: "ws/connect", payload: {url: messengerWsUrl()}, meta: {shouldReconnect: true}});
        }));
        handles.push(p.addListener("notificationTap", (d) => {
            // S1 §7.3: already accepted on the native screen — remembered here, not in the address
            if (d.call?.accept && d.call.callerId && d.call.conversationId) noteNativeAccept(d.call.callerId, d.call.conversationId);
            // spec 002 §3.1: the notification says this chat got something outside the socket — read it again
            if (d.conversationId) markStale(d.conversationId);
            const route = tapRoute(d);
            if (route) navigate(route);
        }));
        return () => {
            setAppBackgrounded(false);
            handles.forEach(removeListener);
        };
    }, [dispatch, navigate, store]);

    useEffect(() => {
        push().setForegroundConversation({conversationId: selectedChatId ?? null}).catch(() => {});
    }, [selectedChatId]);

    // Leaving the messenger (logout, unmount): no conversation is in the foreground any more.
    useEffect(() => () => { push().setForegroundConversation({conversationId: null}).catch(() => {}); }, []);

    return null;
}
