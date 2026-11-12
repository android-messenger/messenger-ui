export const MAX_RECONNECT_DELAY = 30_000;
export  const DELAY_STEP_MS = 250;
// No app-level ping: the messenger backend rejects unknown inbound frames (there is no
// "ping" MessageType) and auto-pings at the WS protocol level every ~10s, to which the
// browser replies pong automatically. Idle timeout on the server is ~35s.