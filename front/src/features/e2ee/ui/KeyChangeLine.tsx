import {useEffect, useSyncExternalStore} from "react";
import {useTranslation} from "react-i18next";
import {dismissKeyChanged, keyChangedPeers, onKeyChanged} from "../lib/keyChange.ts";
import {secretCrypto} from "../crypto.ts";

const NONE: readonly string[] = [];

/**
 * The service line of a chat whose peer changed the key (spec 001, FR-054): a new phone, a reinstall —
 * or somebody in the middle. It stays until the user closes it or compares the safety number again —
 * across reloads too: opening the chat asks the app's library whether the mark is still there.
 */
export function KeyChangeLine({peerUserId, peerName, onVerify}: {peerUserId: string; peerName: string; onVerify: () => void}) {
    const {t} = useTranslation();
    const peers = useSyncExternalStore(onKeyChanged, keyChangedPeers, () => NONE);
    useEffect(() => { void secretCrypto.peerState(peerUserId).catch(() => { /* locked or no keys: shown with the next message */ }); }, [peerUserId]);
    const close = () => {
        dismissKeyChanged(peerUserId);
        void secretCrypto.keyChangeSeen(peerUserId).catch(() => { /* not taken off: the line comes back */ });
    };
    if (!peers.includes(peerUserId)) return null;
    return (
        <div role="status" className="flex items-center justify-center gap-3 text-xs py-1.5 px-3 bg-amber-100 text-amber-900">
            <span>{t("chat.peerKeyChanged", {name: peerName})}</span>
            <button className="underline font-medium" onClick={onVerify}>{t("chat.safetyVerifyTitle")}</button>
            <button aria-label={t("chat.safetyClose")} onClick={close}>✕</button>
        </div>
    );
}
