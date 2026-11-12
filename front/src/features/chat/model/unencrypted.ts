import {isSecretEnvelope} from "@/features/e2ee/wire.ts";

/**
 * Which messages of a chat came in the clear AFTER the chat had become secret. Input is the chat's
 * messages in display order. A message is encrypted if it is marked `secret` or still shows its envelope.
 * Everything before the first encrypted message is the chat's earlier, ordinary history and is not
 * flagged; every later message that is not encrypted is — text from a peer on an old client, or an
 * attachment (attachments are not encrypted yet).
 */
export function unencryptedAfterSecret(messages: ReadonlyArray<{id: string; text?: string; secret?: boolean}>): Set<string> {
    const out = new Set<string>();
    let secretSeen = false;
    for (const m of messages) {
        if (m.secret || isSecretEnvelope(m.text)) secretSeen = true;
        else if (secretSeen) out.add(m.id);
    }
    return out;
}
