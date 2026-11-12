import {useCallback, useEffect, useRef, useState, type RefObject} from "react";
import {useTranslation} from "react-i18next";
import {useVoiceRecorder} from "@/features/chat/hooks/useVoiceRecorder.ts";
import {VOICE_MAX_DURATION_MS} from "@/shared/config/chat.ts";
import {MicIcon, VideoIcon} from "@/shared/ui/icons.tsx";
import {VideoRecorderModal} from "./VideoRecorderModal.tsx";

function formatMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Message composer: attachment-upload progress, the blocked banner (replaces the input when the pair
 * is blocked — mutual, neither side can send), and the input row (attach + textarea + send).
 * Presentational — no scroll/read-receipt state — extracted from ChatWindow verbatim. `inputRef` stays
 * owned by ChatWindow (it focuses the textarea on chat open) and is forwarded here; the file input ref
 * is local to the composer.
 */
export function Composer({
    inputRef,
    inputText,
    setInputText,
    sendMessage,
    onTyping,
    onSendAttachment,
    uploadProgress,
    blocked,
    blockedByPeer,
}: {
    inputRef: RefObject<HTMLTextAreaElement | null>;
    inputText: string;
    setInputText: (value: string) => void;
    sendMessage: (text: string) => void;
    onTyping?: () => void;
    onSendAttachment?: (file: File) => void;
    uploadProgress?: number | null;
    blocked?: boolean;
    blockedByPeer?: boolean;
}) {
    const {t} = useTranslation();
    const fileRef = useRef<HTMLInputElement>(null);
    const [showVideoRecorder, setShowVideoRecorder] = useState(false);
    const {recording, elapsedMs, start, stop, cancel} = useVoiceRecorder();

    // Stop recording and hand the audio to the normal attachment-upload path.
    const sendVoice = useCallback(async () => {
        const file = await stop();
        if (file) onSendAttachment?.(file);
    }, [stop, onSendAttachment]);

    // Auto-send once the recording hits the max length (stop() flips `recording` false immediately, so
    // this fires at most once).
    useEffect(() => {
        if (recording && elapsedMs >= VOICE_MAX_DURATION_MS) void sendVoice();
    }, [recording, elapsedMs, sendVoice]);

    return (
        <>
            {/* Attachment upload progress */}
            {uploadProgress != null && (
                <div className="shrink-0 px-4 pt-2 bg-white">
                    <div className="text-[11px] text-gray-500 mb-1">{t("chat.uploading", {p: uploadProgress})}</div>
                    <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-teal-700 transition-all" style={{width: `${uploadProgress}%`}}/>
                    </div>
                </div>
            )}

            {/* Input — replaced by a banner when the pair is blocked (mutual: neither side can send) */}
            {blocked ? (
                <div className="shrink-0 p-3 bg-gray-100 border-t text-center text-sm text-gray-600">
                    {blockedByPeer ? t("chat.blockedByPeer") : t("chat.blockedByYou")}
                </div>
            ) : recording ? (
                // Recording strip: cancel · live timer · send. Replaces the input row while recording.
                <div className="shrink-0 p-4 bg-white border-t flex items-center gap-3">
                    <button
                        onClick={cancel}
                        title={t("chat.cancelRecording")}
                        aria-label={t("chat.cancelRecording")}
                        className="text-xl px-1 text-red-600 hover:opacity-80"
                    >
                        🗑
                    </button>
                    <div className="flex-1 flex items-center gap-2 text-sm text-gray-700">
                        <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse"/>
                        <span className="tabular-nums">{formatMs(elapsedMs)}</span>
                        <span className="text-gray-400 tabular-nums">/ {formatMs(VOICE_MAX_DURATION_MS)}</span>
                    </div>
                    <button
                        onClick={() => void sendVoice()}
                        title={t("chat.sendVoice")}
                        aria-label={t("chat.sendVoice")}
                        className="bg-teal-950 text-white px-5 py-3.5 rounded-full"
                    >
                        ↑
                    </button>
                </div>
            ) : (
                <div className="shrink-0 p-4 bg-white border-t flex items-center gap-2">
                    <input
                        type="file"
                        ref={fileRef}
                        className="hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onSendAttachment?.(f);
                            e.target.value = "";
                        }}
                    />
                    <button
                        onClick={() => fileRef.current?.click()}
                        title={t("chat.attach")}
                        aria-label={t("chat.attach")}
                        className="text-2xl px-1 hover:opacity-80"
                    >
                        📎
                    </button>
                    <button
                        onClick={() => void start()}
                        title={t("chat.recordVoice")}
                        aria-label={t("chat.recordVoice")}
                        className="p-1.5 text-gray-600 hover:opacity-80"
                    >
                        <MicIcon/>
                    </button>
                    <button
                        onClick={() => setShowVideoRecorder(true)}
                        title={t("chat.recordVideo")}
                        aria-label={t("chat.recordVideo")}
                        className="p-1.5 text-gray-600 hover:opacity-80"
                    >
                        <VideoIcon/>
                    </button>
                    <textarea
                        ref={inputRef}
                        rows={1}
                        placeholder={t("chat.messagePlaceholder")}
                        value={inputText}
                        onChange={(e) => { setInputText(e.target.value); onTyping?.(); }}
                        onKeyDown={(e) => {
                            // Enter sends; Shift+Enter inserts a newline. Ignore IME composition.
                            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                sendMessage(inputText);
                            }
                        }}
                        className="flex-1 border rounded-2xl text-base px-4 py-2 resize-none max-h-32 overflow-y-auto focus:outline-none"
                    />
                    <button
                        onClick={() => sendMessage(inputText)}
                        aria-label={t("chat.send")}
                        title={t("chat.send")}
                        className="bg-teal-950 text-white px-5 py-3.5 rounded-full"
                    >
                        ↑
                    </button>
                </div>
            )}

            {showVideoRecorder && (
                <VideoRecorderModal
                    onSend={(f) => onSendAttachment?.(f)}
                    onClose={() => setShowVideoRecorder(false)}
                />
            )}
        </>
    );
}
