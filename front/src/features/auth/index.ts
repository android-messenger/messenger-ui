// Public API of the auth feature. Cross-feature/layer consumers import from here (the session
// identity, the reset-on-logout action, the session probe, the route guard), not from internals.
// React-free on purpose: this barrel is imported by non-UI consumers (slices, the WS transport), so
// it must not pull a React component into their module graph. The UI route-guard RequireAuth is
// imported directly by the app layer.
export {setUser, clearUser, markInitialized} from "./slices/userSlice.ts";
export type {User} from "./model/types.ts";
export {kratos} from "./model/services/kratos.ts";
