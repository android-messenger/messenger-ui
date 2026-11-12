import { z } from "zod";

// The Contact entity: a chat counterpart as rendered in the list/header (identity + presence dot).
// Shared across features (built by contacts, consumed by chat UI), so it lives in the entities layer.

export const ContactSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    last: z.string().min(0),
    email: z.email().min(1),
    online: z.boolean(),
    // GROUP chat-list items reuse this entity (id = conversationId). "group" lets the list/header
    // branch (group icon, no presence dot/last-seen, no call/block); absent/"direct" = a 1:1 peer.
    kind: z.enum(["direct", "group"]).optional(),
});

export type Contact = z.infer<typeof ContactSchema>;
