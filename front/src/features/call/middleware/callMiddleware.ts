import type {Middleware, PayloadAction} from "@reduxjs/toolkit";
import type {IncomingWebRTCMessage} from "@/features/call/model/types.ts";
import {
    acceptCall,
    incomingAnswer,
    incomingOffer,
    incomingRemoteEnd,
    localEnd,
    pushAnswerFlushed
} from "@/features/call/model/slices/callSlice.js";
import {connected} from "@/infrastructure/slices/websocketSlice.ts";
import type {RootState} from "@/store/store.ts";
import {logger} from "@/shared/logger/logger.ts";
import type {WebRTCService} from "@/features/call/service/webRTCService";
import {selectCallConversationId} from "@/features/chat/model/directDirectory.ts";
import {selectUserName} from "@/features/directory";
import {showCallNotification} from "@/features/notifications";
import toast from "react-hot-toast";
import i18n from "@/shared/i18n";

const exceptionHandler = (ex: Error) => logger.error(ex.message, ex);

// One call:ready per caller within this window: every call:ready makes the caller restart ICE with a new
// offer, and answering an older one never connects.
const READY_DEDUP_MS = 10_000;

export const createCallMiddleware = (webRTCService: WebRTCService): Middleware => {
    let lastReady: {peerId: string; at: number} | null = null;
    return (store) => (next) => (action) => {
        const {dispatch, getState} = store;
        // Capture the peer BEFORE reducers run — call/rejectCall nulls peerId, but we still need
        // it to send call:end to the caller (otherwise the caller never learns the call was declined).
        const peerIdBefore = (getState() as RootState).call.peerId;
        const result = next(action);
        const callAction = action as PayloadAction<unknown>;

        /* ======================
           Incoming WS messages
        ====================== */
        if (callAction.type === "ws/incoming") {
            const msg = (action as PayloadAction<IncomingWebRTCMessage>).payload;

            if (typeof msg?.type === "string" && msg.type.startsWith("call:")) {
                switch (msg.type) {
                    case "call:offer": {
                        const cs = (getState() as RootState).call;
                        const offer = {from: msg.from, sdp: msg.sdp, media: msg.media, conversationId: msg.conversationId};

                        // Already engaged with THIS peer → NEVER decline them. A call:end here would kill
                        // the very call we're answering. A caller re-offers (call:ready re-offer, ICE
                        // restart) while we already hold their offer, so a second offer from the same peer
                        // is normal — handle per our state, never reject it.
                        if (msg.from === cs.peerId) {
                            if (cs.status === "ringing") {
                                dispatch(incomingOffer(offer));   // refresh the stored offer (e.g. ICE restart)
                            } else if (cs.status === "calling") {
                                // GLARE: both calling each other (only via the fallback callback). Perfect-
                                // negotiation tiebreak by user id — the "polite" side yields and answers,
                                // the "impolite" side keeps its own offer (the peer answers it). Avoids a
                                // double-glare deadlock where both become answerers.
                                const myId = (getState() as RootState).user?.id ?? "";
                                if (myId < msg.from) {
                                    webRTCService.endRemote();
                                    dispatch(acceptCall());
                                    webRTCService.handleOffer(offer)
                                        .catch((err) => { exceptionHandler(err); dispatch(localEnd()); });
                                }
                                // impolite → ignore their offer, keep ours.
                            }
                            // connecting / in_call → a late/duplicate offer; ignore (do NOT decline).
                            break;
                        }

                        // A DIFFERENT peer. Only a truly idle client may start ringing; a stray third party
                        // mid-call is declined (declineOffer touches only that caller, not our live call).
                        if (cs.status !== "idle") {
                            logger.warn("declining stray call:offer from another peer while busy",
                                {from: msg.from, status: cs.status, activePeer: cs.peerId});
                            webRTCService.declineOffer(msg.from);
                            break;
                        }
                        // Android app (S1 §7.3): already accepted on the native incoming-call screen → answer
                        // the caller's re-sent offer right away instead of asking a second time.
                        const autoAccept = cs.autoAcceptFrom === msg.from && Date.now() < (cs.autoAcceptUntil ?? 0);
                        dispatch(incomingOffer(offer));
                        if (autoAccept) {
                            dispatch(acceptCall());
                            break;
                        }
                        // ONLINE-but-backgrounded: we got the offer over a live WS, but if the tab is
                        // hidden the user can't see the ringing dialog. The offline Web Push only fires
                        // when the BACKEND thinks we're offline, so this is the only alert in that gap —
                        // post a LOCAL call notification (mirrors the message online-channel). When the tab
                        // is visible the in-app dialog + ringtone already alert, so skip it there.
                        if (typeof document !== "undefined" && document.hidden) {
                            const name = selectUserName(getState(), msg.from);   // best-effort; undefined = generic
                            showCallNotification({
                                // Prefer the conversationId the OFFER carried over the chat directory:
                                // a caller you have no listed chat with isn't in the directory, so without
                                // this the notification had no ?call= → tapping it couldn't answer ("ничего").
                                conversationId: msg.conversationId ?? selectCallConversationId(getState() as RootState, msg.from),
                                callerId: msg.from,
                                media: msg.media,
                                title: name ? name : i18n.t("call.incoming"),
                                body: name ? i18n.t("call.incoming") : "",
                            });
                        }
                        break;
                    }

                    case "call:ready": {
                        // The callee opened from the call push and is ready. If we're STILL ringing them,
                        // re-send our offer so they get a real incoming Accept/Decline dialog. If we've
                        // already given up (idle), ignore — their glare-callback fallback rings us instead.
                        const cs = (getState() as RootState).call;
                        if (cs.status === "calling" && msg.from === cs.peerId) {
                            webRTCService.resendOffer().catch(exceptionHandler);
                        }
                        break;
                    }

                    case "call:answer":
                        webRTCService.handleAnswer(msg).catch(exceptionHandler);
                        // Only transition to "connecting" if we actually have a pending outgoing call
                        // (a pc exists). A late/duplicate answer arriving after teardown must not flip
                        // an idle client back into "connecting" and restart the call-timeout.
                        if (webRTCService.getConnectionState()) dispatch(incomingAnswer());
                        break;

                    case "call:ice":
                        webRTCService.addIce(msg).catch(exceptionHandler);
                        break;

                    case "call:end":
                        webRTCService.endRemote();   // cleanup only — no call:end echo back to a peer that already ended
                        dispatch(incomingRemoteEnd());
                        break;
                }
            }
        }

        /* ======================
           Outgoing call
        ====================== */
        if (callAction.type === "call/outgoingCall") {
            const {peerId, audioOnly, conversationId} =
                (action as PayloadAction<{ peerId: string; audioOnly?: boolean; conversationId?: string }>).payload;

            // A call frame needs a conversationId or the backend drops the SIGNAL_IN and the caller
            // hangs on "calling" until the 30s timeout. It comes from one of two places: an explicit id
            // (a call push deep-link carries it — survives a cold start before getChats loads) or the
            // UNION chat directory (getChats ∪ sticky, so an open-but-empty chat still resolves). Only
            // when NEITHER yields a conversationId do we fail fast with a clear message.
            const st = getState() as RootState;
            if (!conversationId && !selectCallConversationId(st, peerId)) {
                toast.error(i18n.t("call.noConversation"));
                dispatch(localEnd());
                return result;
            }

            webRTCService.startCall(peerId, audioOnly ?? false)
                .then(() => {
                    // Успешно начали звонок
                })
                .catch((err) => {
                    exceptionHandler(err);
                    dispatch(localEnd()); // 🔥 Middleware диспатчит localEnd
                });
        }

        /* ======================
           Answer via push: the callee opened from the incoming-call notification. We ask the still-ringing
           caller to (re)send the offer, which arrives as a normal call:offer → a real incoming dialog here.
           No fallback callback: it fired a spurious (and media-wrong) call AFTER the real one ended, and
           the re-offer path covers the realistic window (the caller rings 60s). If the caller already gave
           up, nothing happens — far better than a bogus ring. conversationId was stashed so call:ready /
           answer / ice route correctly even before getChats loads.

           CRITICAL: on a cold start the WS opens only AFTER we mount, and ws/send drops frames on a closed
           socket — so we can't send call:ready right away. flushPushAnswer() runs it the moment we ARE
           connected: either now (warm start, socket already open) or on the ws/connected transition below.
        ====================== */
        const flushPushAnswer = () => {
            const cs = (getState() as RootState).call;
            const p = cs.pendingPushAnswer;
            if (!p || cs.status !== "idle") return;   // nothing pending, or a real offer already arrived
            dispatch(pushAnswerFlushed());             // one-shot: don't re-send on a later reconnect
            const now = Date.now();
            if (lastReady && lastReady.peerId === p.peerId && now - lastReady.at < READY_DEDUP_MS) return;
            lastReady = {peerId: p.peerId, at: now};
            webRTCService.signalReady(p.peerId);
        };
        if (callAction.type === "call/answerViaPush") {
            if ((getState() as RootState).ws.status === "connected") flushPushAnswer();
            // else: stays pending, flushed by the ws/connected branch when the socket opens.
        }
        if (callAction.type === connected.type) {
            flushPushAnswer();
        }

        /* ======================
           Accept incoming call
        ====================== */
        if (callAction.type === "call/acceptCall") {
            const state = getState() as RootState;
            const offer = state.call.incomingOfferData;

            if (offer) {
                webRTCService.handleOffer(offer).catch((err) => {
                    exceptionHandler(err);
                    // Accepting failed (camera denied / negotiation error) — drop back to idle so
                    // the UI doesn't hang on "connecting" (symmetric with the outgoing-call path).
                    dispatch(localEnd());
                });
            }
        }

        /* ======================
           Local hangup
        ====================== */
        if (callAction.type === "call/localEnd") {
            webRTCService.hangUp();
        }

        /* ======================
           Reject incoming call
        ====================== */
        if (callAction.type === "call/rejectCall") {
            if (peerIdBefore) {
                webRTCService.rejectCall(peerIdBefore);
            }
        }

        // NOTE: the "connected" → in_call transition (and "failed/closed" → idle) is now driven by
        // webRTCService's onConnectionStateChange callbacks (wired in store.ts), not polled here on
        // incidental Redux traffic.

        return result;
    };
};