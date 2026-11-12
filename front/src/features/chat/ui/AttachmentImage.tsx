import {useTranslation} from "react-i18next";
import {loadAttachmentBlob, saveAttachmentBlob, deleteAttachmentBlob} from "@/features/chat/db/db.ts";
import {blobToThumb} from "@/features/chat/lib/imageCompress.ts";
import {THUMB_MAX_DIMENSION, THUMB_QUALITY} from "@/shared/config/chat.ts";
import {useAttachmentObjectUrl} from "@/features/chat/lib/useAttachmentObjectUrl.ts";
import {useLightbox} from "@/features/chat/ui/lightboxContext.ts";

// Stable module-level fns for the shared cache layer (must not be recreated per render).
const toThumb = (blob: Blob) => blobToThumb(blob, THUMB_MAX_DIMENSION, THUMB_QUALITY);

/**
 * Inline thumbnail for an image attachment. All fetch/cache/refresh logic lives in the shared
 * useAttachmentObjectUrl layer: it serves a local blob: URL (a cached WebP thumbnail, or one it
 * downscales+caches on first fetch), so a presigned URL expiring never blanks the picture. Tapping opens
 * the full-res image by resolving a FRESH presigned URL on demand.
 */
export function AttachmentImage({
    attachmentId,
    fileName,
    resolveUrl,
}: {
    attachmentId: string;
    fileName: string;
    resolveUrl?: (attachmentId: string) => Promise<string | null>;
}) {
    const {t} = useTranslation();
    const {url, failed, retry} = useAttachmentObjectUrl({
        attachmentId,
        resolveUrl,
        load: loadAttachmentBlob,
        save: saveAttachmentBlob,
        invalidate: deleteAttachmentBlob,
        transform: toThumb,
    });

    const {open: openLightbox} = useLightbox();
    const openFull = async () => {
        // Always resolve a fresh presigned URL for the full-res view (never a stale/expired one), then
        // show it in the in-app lightbox instead of a new browser tab.
        const u = (await resolveUrl?.(attachmentId).catch(() => null)) ?? null;
        if (u) openLightbox(u);
    };

    if (failed) return (
        <button onClick={retry} className="break-all underline decoration-dotted" title={fileName}>
            📎 {fileName} — ↻
        </button>
    );
    if (!url) return <span className="opacity-60 text-xs">🖼 {t("chat.loadingImage")}</span>;
    return (
        // inline-block + a BLOCK img so the button box hugs the image exactly (an inline img sits on the
        // text baseline, leaving the button taller than the picture → only a corner was clickable).
        <button onClick={openFull} title={fileName}
                className="inline-block align-top p-0 border-0 bg-transparent cursor-pointer">
            <img
                src={url}
                alt={fileName}
                onError={retry}
                className="block max-w-[200px] max-h-[200px] rounded-md"
            />
        </button>
    );
}
