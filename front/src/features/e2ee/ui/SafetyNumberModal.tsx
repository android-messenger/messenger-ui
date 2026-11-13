import {useEffect, useState} from "react";
import {useTranslation} from "react-i18next";
import {secretCrypto, formatSafetyNumber} from "../index.ts";
import {dismissKeyChanged} from "../lib/keyChange.ts";

/**
 * Safety-number verification (MITM check). Shows the number the app's library derives from both parties'
 * identity keys; the user compares it out-of-band with the peer and marks them verified. After a key
 * change the library asks to compare again.
 */
export function SafetyNumberModal({peerUserId, peerName, onClose}: {
    peerUserId: string; peerName: string; onClose: () => void;
}) {
    const {t} = useTranslation();
    const [num, setNum] = useState<string | null | undefined>(undefined);   // undefined = loading
    const [verified, setVerified] = useState(false);

    useEffect(() => {
        let alive = true;
        void (async () => {
            const n = await secretCrypto.safetyNumber(peerUserId);
            const state = await secretCrypto.peerState(peerUserId);
            if (!alive) return;
            setNum(n);
            setVerified(state.trust === "verified");
        })();
        return () => { alive = false; };
    }, [peerUserId]);

    const toggle = () => {
        if (!num) return;
        const next = !verified;
        // Verifying again — or taking the mark off — is also what lets messages go out after a key change.
        // The mark goes to the key whose number is on the screen (`num`). If the key changed while the dialog
        // was open, the call is refused: show the new number, not verified — the user compares again.
        void secretCrypto.setVerified(peerUserId, next, num).then(
            () => { setVerified(next); dismissKeyChanged(peerUserId); },
            async () => {
                const n = await secretCrypto.safetyNumber(peerUserId).catch(() => null);
                const state = await secretCrypto.peerState(peerUserId).catch(() => null);
                if (n) setNum(n);
                setVerified(state?.trust === "verified");
            },
        );
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 safe-area-pad-4" onClick={onClose}>
            <div className="bg-white text-teal-950 rounded-xl max-w-sm w-full p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-semibold flex items-center gap-2">🔒 {t("chat.safetyTitle")}</h3>
                <p className="text-sm text-teal-800 mt-1">{t("chat.safetyDesc", {name: peerName})}</p>

                {num === undefined ? (
                    <div className="my-6 flex flex-col items-center gap-3 text-teal-600" role="status" aria-label={t("chat.safetyComputing")}>
                        {/* A three-dot pulse while the app answers (it may wait for the screen unlock). */}
                        <span className="flex gap-1.5" aria-hidden="true">
                            <span className="w-2 h-2 rounded-full bg-teal-500 animate-bounce motion-reduce:animate-none [animation-delay:-0.3s]"/>
                            <span className="w-2 h-2 rounded-full bg-teal-500 animate-bounce motion-reduce:animate-none [animation-delay:-0.15s]"/>
                            <span className="w-2 h-2 rounded-full bg-teal-500 animate-bounce motion-reduce:animate-none"/>
                        </span>
                        <span className="text-sm">{t("chat.safetyComputing")}</span>
                    </div>
                ) : num === null ? (
                    <div className="my-6 text-center text-amber-700 text-sm">{t("chat.safetyUnknown")}</div>
                ) : (
                    <>
                        <div className="my-4 font-mono text-[15px] leading-7 tracking-wide text-center bg-teal-50 rounded-lg p-3 break-words select-all">
                            {formatSafetyNumber(num)}
                        </div>
                        {verified && <div className="text-center text-green-700 text-sm font-medium mb-2">✓ {t("chat.safetyVerified")}</div>}
                        <button
                            onClick={toggle}
                            className={`w-full py-2 rounded-lg font-medium ${verified ? "bg-teal-100 text-teal-800" : "bg-teal-700 text-white hover:bg-teal-800"}`}
                        >
                            {verified ? t("chat.safetyUnverify") : t("chat.safetyVerify")}
                        </button>
                    </>
                )}

                <button onClick={onClose} className="w-full mt-2 py-2 text-teal-700 text-sm hover:underline">
                    {t("chat.safetyClose")}
                </button>
            </div>
        </div>
    );
}
