import {useEffect, useState} from "react";
import {webRTCService} from "@/features/call/service/webRTCService";
import {useDispatch} from "react-redux";
import type {AppDispatch} from "@/store/store.ts";
import {localEnd} from "@/features/call/model/slices/callSlice";

export function useWebRTC() {
    const dispatch = useDispatch<AppDispatch>();

    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

    useEffect(() => {
        // 🔥 Инжектим dispatch и callbacks в service
        webRTCService.setStreamCallbacks(setLocalStream, setRemoteStream);
    }, [dispatch]);

    // Tear down any active call when the messenger unmounts (e.g. a 401 re-auth redirect or a route
    // change). Without this the RTCPeerConnection dangles and the camera/mic tracks stay live — the
    // device's camera LED stays on and the peer is left "connected" to a dead session. Route through
    // localEnd so the peer is signaled and Redux resets too. No-op when there's no active connection.
    useEffect(() => {
        return () => {
            if (webRTCService.getConnectionState()) dispatch(localEnd());
        };
    }, [dispatch]);

    return {
        localStream,
        remoteStream,
    };
}