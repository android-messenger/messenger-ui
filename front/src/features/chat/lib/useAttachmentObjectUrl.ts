import {useEffect, useState} from "react";

/**
 * Shared attachment fetch-and-cache layer for inline media (images, voice notes). ONE place owns the
 * whole lifecycle so every consumer behaves the same and can't drift:
 *
 *   cache hit → serve a local blob: URL (zero network, never expires)
 *   cache miss → resolve a presigned GET (retry a few times for a just-uploaded object), fetch the bytes
 *                (abortable), optionally transform (e.g. downscale an image to a thumbnail), persist, and
 *                serve from the resulting blob.
 *
 * Key property: the element is fed a `blob:` URL built from bytes we hold — NOT the presigned URL. So a
 * presigned URL expiring (300s TTL) can never blank out a shown attachment; the presigned is used only
 * during the fetch, right after it was resolved. `onError` from the media element calls `retry()`, which
 * drops the (possibly corrupt) cache entry and re-resolves a FRESH presigned URL.
 *
 * `load`/`save`/`invalidate`/`transform` MUST be stable (module-level) functions — they're read via
 * closure and intentionally not in the effect deps (only attachmentId / retry-attempt / resolveUrl are).
 */
export function useAttachmentObjectUrl(opts: {
    attachmentId: string;
    resolveUrl?: (attachmentId: string) => Promise<string | null>;
    load?: (attachmentId: string) => Promise<Blob | null>;
    save?: (attachmentId: string, blob: Blob) => Promise<void>;
    invalidate?: (attachmentId: string) => Promise<void>;
    transform?: (blob: Blob) => Promise<Blob>;
}): {url: string | null; failed: boolean; retry: () => void} {
    const {attachmentId, resolveUrl, load, save, invalidate, transform} = opts;
    const [url, setUrl] = useState<string | null>(null); // a blob: URL
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    // Reset on attachment change during render (not in the effect) so the effect only loads.
    const [prevId, setPrevId] = useState(attachmentId);
    if (attachmentId !== prevId) { setPrevId(attachmentId); setUrl(null); setFailed(false); }

    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let objectUrl: string | null = null;
        const abort = new AbortController();
        let tries = 0;
        const MAX = 4;

        const serve = (blob: Blob) => {
            objectUrl = URL.createObjectURL(blob);
            if (alive) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
        };
        const fail = () => { if (++tries < MAX) timer = setTimeout(go, 800 * tries); else setFailed(true); };

        function go() {
            resolveUrl?.(attachmentId)
                .then(async (presigned) => {
                    if (!alive) return;
                    if (!presigned) { fail(); return; }
                    try {
                        // credentials: the app build fetches the edge cross-origin, and the edge's auth_request
                        // needs the Kratos cookie (same-origin in the web build: no change there)
                        const resp = await fetch(presigned, {signal: abort.signal, credentials: "include"});
                        if (!resp.ok) throw new Error("download " + resp.status);
                        let blob = await resp.blob();
                        if (transform) blob = await transform(blob).catch(() => blob);
                        if (!alive) return;
                        save?.(attachmentId, blob).catch(() => { /* best-effort persist */ });
                        serve(blob);
                    } catch {
                        if (alive) fail(); // AbortError also lands here, but alive is false by then → no-op
                    }
                })
                .catch(() => { if (alive) fail(); });
        }

        (async () => {
            if (load) {
                const cached = await load(attachmentId).catch(() => null);
                if (!alive) return;
                if (cached) { serve(cached); return; }
            }
            go();
        })();

        return () => {
            alive = false;
            abort.abort();
            if (timer) clearTimeout(timer);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
        // load/save/invalidate/transform are stable module fns (see doc) — deliberately not deps.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attachmentId, attempt, resolveUrl]);

    // Drop the (possibly stale/corrupt) cache entry and re-run: re-resolve a FRESH presigned + re-fetch.
    const retry = () => {
        setFailed(false);
        setUrl(null);
        invalidate?.(attachmentId).catch(() => { /* best-effort */ });
        setAttempt((a) => a + 1);
    };

    return {url, failed, retry};
}
