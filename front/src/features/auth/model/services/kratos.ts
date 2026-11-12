import { Configuration, FrontendApi } from "@ory/client";
import {kratosUrl} from "@/shared/config/kratos.ts";

export const kratos = new FrontendApi(
    new Configuration({
        basePath: kratosUrl,
        baseOptions: {
            withCredentials: true,
            // Bound every Kratos call. Without this, a stalled request (flaky mobile network, or a
            // hung edge on an expired-cookie whoami) never settles → RequireAuth's checkSession never
            // resolves → the app hangs on "Loading…" forever instead of falling back to /login.
            timeout: 10000,
        },
    })
);