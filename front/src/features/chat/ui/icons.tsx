// Minimalist line icons (Feather-style): 16px, stroke = currentColor, no fill — so they inherit the menu
// row's color (incl. the red for "delete") and read as one consistent set, not mixed emoji.
const base = {
    width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
} as const;

export const CopyIcon = () => (
    <svg {...base} aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </svg>
);

export const ForwardIcon = () => (
    <svg {...base} aria-hidden="true">
        <polyline points="15 17 20 12 15 7" />
        <path d="M20 12H9a5 5 0 0 0-5 5v1" />
    </svg>
);

export const TrashIcon = () => (
    <svg {...base} aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
        <path d="M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v5M14 11v5" />
    </svg>
);
