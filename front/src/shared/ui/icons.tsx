import type {SVGProps} from "react";

/**
 * Minimal line icons (stroke = currentColor) used for the call/record actions, replacing the emoji
 * glyphs (📞/🎥/🎤) which render inconsistently across platforms and read as cartoonish. Each inherits
 * the button's text color and sizing via `width`/`className`.
 */
function base(props: SVGProps<SVGSVGElement>) {
    return {
        viewBox: "0 0 24 24",
        width: 22,
        height: 22,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
        "aria-hidden": true,
        ...props,
    };
}

/** Voice call — phone handset. */
export function PhoneIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg {...base(props)}>
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
    );
}

/** Video call — camera. */
export function VideoIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg {...base(props)}>
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </svg>
    );
}

/** Encryption — a schematic key (ring + shaft + teeth). `struck` draws a diagonal line through it to mean
 * "off / no encryption". Line style matches the call/mic icons. */
export function KeyIcon({struck, ...props}: SVGProps<SVGSVGElement> & {struck?: boolean}) {
    return (
        <svg {...base(props)}>
            <circle cx="7" cy="16.6" r="4.4"/>
            <path d="M10.1 13.5 L20.5 3"/>
            <path d="M16.3 6.8 l2.6 2.6"/>
            <path d="M18.7 4.4 l2.6 2.6"/>
            {struck && <line x1="3.2" y1="3.2" x2="20.8" y2="20.8"/>}
        </svg>
    );
}

/** Verify identity — a fingerprint (concentric ridges). For safety-number verification. */
export function FingerprintIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg {...base(props)}>
            <path d="M5 11a7 7 0 0 1 13.5-2.5"/>
            <path d="M8 12a4 4 0 0 1 8 0v3.5"/>
            <path d="M12 12v5"/>
            <path d="M5.5 14.5v2.5"/>
            <path d="M18.5 12v4.5"/>
        </svg>
    );
}

/** Record a voice message — microphone. */
export function MicIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg {...base(props)}>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
    );
}
