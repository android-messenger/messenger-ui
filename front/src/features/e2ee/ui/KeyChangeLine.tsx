import {useSyncExternalStore} from "react";
import {useTranslation} from "react-i18next";
import {dismissKeyChanged, keyChangedPeers, onKeyChanged} from "../lib/keyChange.ts";

const NONE: readonly string[] = [];

/**
 * The service line of a chat whose peer changed the key (spec 001, FR-054): a new phone, a reinstall —
 * or somebody in the middle. It stays until the user opens the safety number or dismisses it.
 */
export function KeyChangeLine({peerUserId, peerName, onVerify}: {peerUserId: string; peerName: string; onVerify: () => void}) {
    const {t} = useTranslation();
    const peers = useSyncExternalStore(onKeyChanged, keyChangedPeers, () => NONE);
    if (!peers.includes(peerUserId)) return null;
    return (
        <div role="status" className="flex items-center justify-center gap-3 text-xs py-1.5 px-3 bg-amber-100 text-amber-900">
            <span>{t("chat.peerKeyChanged", {name: peerName})}</span>
            <button className="underline font-medium" onClick={onVerify}>{t("chat.safetyVerifyTitle")}</button>
            <button aria-label={t("chat.safetyClose")} onClick={() => dismissKeyChanged(peerUserId)}>✕</button>
        </div>
    );
}
