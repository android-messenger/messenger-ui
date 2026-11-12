import {createContext, useContext} from "react";

// Context + hook for the in-app image viewer, split out of Lightbox.tsx so that file can export only a
// component (react-refresh/only-export-components).
export type LightboxCtx = {open: (url: string) => void};
export const LightboxContext = createContext<LightboxCtx>({open: () => {}});

export function useLightbox(): LightboxCtx {
    return useContext(LightboxContext);
}
