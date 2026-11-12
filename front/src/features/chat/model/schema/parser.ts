import { ChatMessageSchema, type ChatMessage } from "./domainChatMessage.schema";
import {logger} from "@/shared/logger/logger.ts";

export function parseChatMessage(data: unknown): ChatMessage | null {
    const result = ChatMessageSchema.safeParse(data);
    if (!result.success) {
        logger.warn("Invalid ChatMessage:", result.error.message);
        return null;
    }
    return result.data;
}
