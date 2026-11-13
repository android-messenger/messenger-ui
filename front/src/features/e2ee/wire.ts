// The part of the E2EE feature that holds no keys and no state: what a secret message looks like on the
// wire, how a failed one is classified and shown, the rekey-hint frame, the names of the feature's storage.
// Code outside the feature imports these from here and everything else from the feature's index — never
// from lib/ or recovery/ (eslint enforces it).

export {isSecretEnvelope} from "./lib/envelope.ts";
export {classifyDecryptError, isRecoverable, isWrongDevice, secretStateKey, sendFailureKey, refusalCode, type DecryptFailure, type SecretMsgState} from "./lib/failure.ts";
export {buildRekeyHint, makeThrottle, REKEY_COALESCE_MS} from "./lib/rekeyHint.ts";
export {E2EE_LS, E2EE_DATABASES} from "./lib/stores.ts";
// The app's Vault (Android Keystore). The chat cache wraps its own key with it (features/chat/db/sealed.ts).
export {wrapBytes, unwrapBytes, type Wrapped} from "./lib/deviceKey.ts";
