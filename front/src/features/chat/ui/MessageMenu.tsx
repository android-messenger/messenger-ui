import {useEffect, useRef, useState, type ReactNode} from "react";
import {useTranslation} from "react-i18next";

export interface MsgMenuItem {
    key: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    danger?: boolean;
    ariaLabel?: string;   // keep stable aria-labels for specific actions (e.g. delete)
}

/**
 * Per-message actions menu (Copy / Forward / Delete …), like a normal messenger: a "⋯" trigger that opens
 * a dropdown of labeled, full-width tappable rows — not tiny inline glyphs. The trigger is revealed on
 * hover on desktop and shown subtly (always tappable) on touch. Closes on outside-click / Escape.
 * `align` places the dropdown on the message's side so it never runs off-screen.
 */
export function MessageMenu({items, align}: {items: MsgMenuItem[]; align: "left" | "right"}) {
    const {t} = useTranslation();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
    }, [open]);

    if (items.length === 0) return null;
    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-label={t("chat.messageActions", {defaultValue: "Message actions"})}
                aria-haspopup="menu"
                aria-expanded={open}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-black/10 text-current leading-none opacity-60 hover:bg-black/20 hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-70 transition-opacity"
            >
                ⋯
            </button>
            {open && (
                <div
                    role="menu"
                    className={`absolute z-30 mt-1 min-w-[168px] overflow-hidden rounded-lg bg-white py-1 text-teal-950 shadow-xl ring-1 ring-black/10 ${align === "right" ? "right-0" : "left-0"}`}
                >
                    {items.map((it) => (
                        <button
                            key={it.key}
                            role="menuitem"
                            type="button"
                            aria-label={it.ariaLabel ?? it.label}
                            onClick={() => { setOpen(false); it.onClick(); }}
                            className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm hover:bg-gray-100 ${it.danger ? "text-red-600" : "text-teal-800"}`}
                        >
                            <span aria-hidden className="flex w-4 shrink-0 items-center justify-center">{it.icon}</span>
                            {it.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
