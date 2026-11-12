import {useSyncExternalStore} from "react";
import {useTranslation} from "react-i18next";
import {isVaultWaitLong, onVaultWait} from "../lib/deviceKey.ts";

// Shown while a secret-chat operation has been waiting for the phone's protected storage for more than a
// few seconds: it opens only while the screen is unlocked. Without this the user sees an endless
// "decrypting…". Nothing is lost while it shows; the operation finishes by itself after the unlock.
export function VaultWaitBanner() {
    const {t} = useTranslation();
    const long = useSyncExternalStore(onVaultWait, isVaultWaitLong, () => false);
    if (!long) return null;
    return (
        <div role="status" className="absolute bottom-0 inset-x-0 z-40 text-center text-xs py-1 bg-amber-600 text-white">
            {t("chat.vaultLocked")}
        </div>
    );
}
