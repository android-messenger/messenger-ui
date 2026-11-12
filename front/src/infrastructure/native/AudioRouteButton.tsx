// Android app only (S1 §4.5): choose where the call sound goes — earpiece, loudspeaker, Bluetooth or
// a wired headset — through the native `Call` plugin. Loaded lazily from VideoCall when isNativeApp().
import {useEffect, useState} from "react";
import {useTranslation} from "react-i18next";
import {callPlugin, removeListener, type AudioRoute, type PluginListenerHandle} from "@/shared/platform.ts";

const ICON: Record<AudioRoute, string> = {earpiece: "📱", speaker: "🔊", bluetooth: "🎧", wired: "🎧"};

export default function AudioRouteButton({className}: { className?: string }) {
    const {t} = useTranslation();
    const [routes, setRoutes] = useState<AudioRoute[]>([]);
    const [current, setCurrent] = useState<AudioRoute | "">("");
    const [open, setOpen] = useState(false);

    const refresh = () => {
        callPlugin().getAudioRoutes()
            .then((r) => { setRoutes(r.routes); setCurrent(r.current); })
            .catch(() => { /* no active call service yet */ });
    };

    useEffect(() => {
        refresh();
        let handle: Promise<PluginListenerHandle> | null = null;
        try {
            handle = callPlugin().addListener("audioRouteChanged", (d) => { setCurrent(d.route); refresh(); });
        } catch { /* outside the app */ }
        return () => removeListener(handle);
    }, []);

    if (routes.length < 2) return null;

    const choose = (route: AudioRoute) => {
        setOpen(false);
        callPlugin().setAudioRoute({route}).then(refresh).catch(refresh);
    };

    return (
        <div className={className}>
            {open && (
                <div className="mb-2 flex flex-col rounded-xl bg-black/70 p-1 text-white">
                    {routes.map((r) => (
                        <button
                            key={r}
                            onClick={() => choose(r)}
                            className={`px-4 py-2 text-left rounded-lg ${r === current ? "bg-white/20" : ""}`}
                        >
                            {ICON[r]} {t(`call.route_${r}`)}
                        </button>
                    ))}
                </div>
            )}
            <button
                onClick={() => { refresh(); setOpen((o) => !o); }}
                aria-label={t("call.route")}
                className="bg-white/20 text-white px-4 py-3 rounded-full hover:bg-white/30 transition-colors"
            >
                {current ? ICON[current] : "🔊"} {t(current ? `call.route_${current}` : "call.route")}
            </button>
        </div>
    );
}
