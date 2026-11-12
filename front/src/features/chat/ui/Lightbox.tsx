import {useCallback, useEffect, useState, type ReactNode} from "react";
import {LightboxContext} from "./lightboxContext.ts";

/**
 * In-app full-screen image viewer. A provider holds the currently-open image URL and renders the
 * overlay; `useLightbox().open(url)` shows it. Replaces opening the full-res image in a new browser tab.
 * Double-tap / double-click toggles between fit-to-screen and natural size (pan by scrolling); tapping
 * the backdrop, the ✕, or pressing Esc closes it.
 */
export function LightboxProvider({children}: {children: ReactNode}) {
    const [url, setUrl] = useState<string | null>(null);
    const [zoomed, setZoomed] = useState(false);

    const open = useCallback((u: string) => { setUrl(u); setZoomed(false); }, []);
    const close = useCallback(() => setUrl(null), []);

    // Esc closes; lock body scroll while open.
    useEffect(() => {
        if (!url) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        window.addEventListener("keydown", onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
    }, [url, close]);

    return (
        <LightboxContext.Provider value={{open}}>
            {children}
            {url && (
                <div
                    className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center safe-area-pad"
                    onClick={close}
                >
                    <button
                        onClick={close}
                        aria-label="Cerrar"
                        className="absolute top-[calc(0.75rem+var(--wolp-sat))] right-[calc(1rem+var(--wolp-sar))] text-white/80 hover:text-white text-4xl leading-none z-10"
                    >
                        ×
                    </button>
                    <div
                        className="max-w-full max-h-full overflow-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <img
                            src={url}
                            alt=""
                            onDoubleClick={() => setZoomed((z) => !z)}
                            className={zoomed
                                ? "max-w-none cursor-zoom-out"
                                : "max-w-[100vw] max-h-[100dvh] object-contain cursor-zoom-in select-none"}
                            draggable={false}
                        />
                    </div>
                </div>
            )}
        </LightboxContext.Provider>
    );
}
