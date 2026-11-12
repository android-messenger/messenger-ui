import type {useNavigate} from "react-router-dom";
import {useEffect, useState} from "react";
import {requireNoSession} from "@/features/auth/model/services/kratosFlows.ts";

export default function useNoSessionFlow<T>(
    initFlow: () => Promise<T>,
    navigate: ReturnType<typeof useNavigate>
) {
    const [flow, setFlow] = useState<T | null>(null);

    useEffect(() => {
        let active = true;

        requireNoSession().then((allowed) => {
            if (!allowed) {
                navigate("/", { replace: true });
                return;
            }
            initFlow().then((f) => active && setFlow(f));
        });

        return () => {
            active = false;
        };
    }, [navigate, initFlow]);

    return [flow, setFlow] as const;
}
