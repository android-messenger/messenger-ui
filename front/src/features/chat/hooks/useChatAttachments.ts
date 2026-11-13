import {useCallback, useState} from "react";
import toast from "react-hot-toast";
import {useTranslation} from "react-i18next";

import {logger} from "@/shared/logger/logger.ts";
import {MAX_ATTACHMENT_BYTES, IMAGE_MAX_DIMENSION, IMAGE_QUALITY, IMAGE_COMPRESS_MIN_BYTES} from "@/shared/config/chat.ts";
import {compressImage} from "@/features/chat/lib/imageCompress.ts";
import {videoPosterBlob} from "@/features/chat/lib/videoPoster.ts";
import {saveAttachmentBlob} from "@/features/chat/db/db.ts";
import {files, isNativeApp} from "@/shared/platform.ts";
import {listsReady, LISTS_NOT_READY_KEY} from "@/features/chat/model/sealedLists.ts";
import {
    useAttachmentUploadUrlMutation,
    useAttachmentConfirmMutation,
    useAttachmentDownloadUrlMutation,
} from "@/features/chat/rest/chatApi.ts";

/**
 * Attachment lifecycle for the open conversation, split out of the useChat god-hook: two-phase
 * presigned upload (get URL → PUT with progress → confirm → reload history), download (open a fresh
 * presigned URL), and resolve (a presigned GET for inline image previews). Behavior is unchanged —
 * this is a cohesion extraction.
 */
export function useChatAttachments(
    selectedChatId: string | null,
    reloadChatHistory: () => Promise<unknown>,
) {
    const {t} = useTranslation();
    const [uploadProgress, setUploadProgress] = useState<number | null>(null);
    const [uploadUrlMut] = useAttachmentUploadUrlMutation();
    const [confirmMut] = useAttachmentConfirmMutation();
    const [downloadUrlMut] = useAttachmentDownloadUrlMutation();

    const sendAttachment = useCallback(async (original: File) => {
        if (!selectedChatId || !original) return;
        // Same rule as for text: nothing is sent before the sealed lists are read (sealedLists.ts).
        if (!listsReady()) { toast.error(t(LISTS_NOT_READY_KEY)); return; }
        if (original.size > MAX_ATTACHMENT_BYTES) {
            toast.error(t("chat.fileTooLarge", {mb: Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}));
            return;
        }
        setUploadProgress(0);
        try {
            // Downscale + re-encode images to WebP client-side before upload (no-op for non-images /
            // small ones / when it wouldn't help). Never blocks the send — failures fall back to the
            // original inside compressImage.
            const file = await compressImage(original, {
                maxDimension: IMAGE_MAX_DIMENSION, quality: IMAGE_QUALITY, minBytes: IMAGE_COMPRESS_MIN_BYTES,
            });
            const contentType = file.type || "application/octet-stream";
            const up = await uploadUrlMut({
                chatId: selectedChatId, fileName: file.name, contentType, sizeBytes: file.size,
            }).unwrap();
            // XHR (not fetch) so we can report upload progress to the composer.
            await new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open(up.method || "PUT", up.uploadUrl);
                xhr.withCredentials = true; // app build: cross-origin edge needs the Kratos cookie (no-op same-origin)
                xhr.setRequestHeader("Content-Type", contentType);
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
                };
                xhr.onload = () =>
                    xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("upload PUT " + xhr.status));
                xhr.onerror = () => reject(new Error("upload network error"));
                xhr.send(file);
            });
            await confirmMut({chatId: selectedChatId, attachmentId: up.attachmentId}).unwrap();
            // Cache a first-frame poster from the LOCAL blob so the sender's just-sent video shows a real
            // thumbnail immediately (not a black 🎬 placeholder). Best-effort, off the send path.
            if (contentType.startsWith("video/")) {
                videoPosterBlob(file)
                    .then((poster) => { if (poster) return saveAttachmentBlob(up.attachmentId, poster); })
                    .catch(() => { /* best-effort poster */ });
            }
            reloadChatHistory().catch(() => {});
            toast.success(t("chat.fileSent"));
        } catch (e) {
            logger.error("sendAttachment failed", e as Error);
            toast.error(t("chat.fileError"));
        } finally {
            setUploadProgress(null);
        }
    }, [selectedChatId, uploadUrlMut, confirmMut, reloadChatHistory, t]);

    const downloadAttachment = useCallback(async (attachmentId: string, meta?: {fileName?: string; contentType?: string}) => {
        if (!selectedChatId || !attachmentId) return;
        try {
            const r = await downloadUrlMut({chatId: selectedChatId, attachmentId}).unwrap();
            const ct = meta?.contentType ?? "";
            // Android app: the WebView neither opens the API host as a document nor handles downloads;
            // the native side saves the file where the user picks (S1 §5.4) and opens PDFs itself.
            if (isNativeApp()) {
                const res = await files().saveDownload({url: r.downloadUrl, fileName: meta?.fileName, mimeType: ct || undefined});
                if (res.saved) toast.success(t("chat.fileSaved"));
                return;
            }
            const name = (meta?.fileName ?? "").toLowerCase();
            // PDFs (and anything the browser renders) open in a tab to VIEW. Everything else — Word/Excel/
            // zip/… — must be DOWNLOADED with its real filename: opening e.g. a .docx in a tab shows a
            // browser error instead of the document. The presigned URL is same-origin (the edge), so the
            // <a download> attribute is honored.
            const viewable = ct === "application/pdf" || name.endsWith(".pdf");
            if (viewable) {
                window.open(r.downloadUrl, "_blank", "noopener");
            } else {
                const a = document.createElement("a");
                a.href = r.downloadUrl;
                a.download = meta?.fileName || "archivo";
                a.rel = "noopener";
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
        } catch (e) {
            logger.error("downloadAttachment failed", e as Error);
            toast.error(t("chat.downloadError"));
        }
    }, [selectedChatId, downloadUrlMut, t]);

    // Resolve a fresh presigned GET URL (for inline image previews). Presigned URLs expire
    // (download-ttl-seconds), so the caller fetches on render rather than caching.
    const getAttachmentUrl = useCallback(async (attachmentId: string): Promise<string | null> => {
        if (!selectedChatId || !attachmentId) return null;
        try {
            const r = await downloadUrlMut({chatId: selectedChatId, attachmentId}).unwrap();
            return r.downloadUrl;
        } catch (e) {
            logger.error("getAttachmentUrl failed", e as Error);
            return null;
        }
    }, [selectedChatId, downloadUrlMut]);

    return {uploadProgress, sendAttachment, downloadAttachment, getAttachmentUrl};
}
