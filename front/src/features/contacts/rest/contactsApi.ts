import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import { z } from "zod";
import { ContactSchema } from "@/entities/contact";
import { MESSENGER_API } from "@/shared/config/api.ts";

// NOTE: the messenger backend does not expose /contacts endpoints (client directory is a
// separate service). These calls will 404 against it; the chat list is driven by GET /api/chats.
export const contactsApi = createApi({
    reducerPath: "contactsApi",
    baseQuery: fetchBaseQuery({ baseUrl: MESSENGER_API, credentials: "include" }),
    tagTypes: ["Contact"],
    endpoints: (builder) => ({
        // ----------------
        // поиск пользователя по email
        // ----------------
        lookupUser: builder.mutation<{ found: boolean; user?: z.infer<typeof ContactSchema> }, string>({
            query: (email) => ({
                url: `/contacts/lookup`,
                method: "POST",
                body: { email },
            }),
            transformResponse: (response: unknown) => {
                // используем Zod для валидации
                const parsed = response ? ContactSchema.safeParse(response) : null;

                if (parsed?.success) {
                    return { found: true, user: parsed.data };
                } else {
                    return { found: false };
                }
            },
            invalidatesTags: (result) =>
                result?.user ? [{ type: "Contact", id: result.user.id }] : [],
        }),

        // ----------------
        // получить пользователей по списку id
        // ----------------
        getUsersByIds: builder.query<z.infer<typeof ContactSchema>[], { ids: string[] }>({
            query: ({ ids }) => ({
                url: "/contacts",
                method: "POST",
                body: { ids },
            }),
            transformResponse: (response: unknown) => {
                // ожидаем массив, валидируем каждый элемент
                if (!Array.isArray(response)) return [];
                return response
                    .map((r) => ContactSchema.safeParse(r))
                    .filter((p): p is { success: true; data: z.infer<typeof ContactSchema> } => p?.success)
                    .map((p) => p.data);
            },
            providesTags: (result) =>
                result
                    ? [
                        ...result.map((u) => ({ type: "Contact" as const, id: u.id })),
                        { type: "Contact", id: "LIST" },
                    ]
                    : [{ type: "Contact", id: "LIST" }],
        }),
    }),
});

// --------------------
// Auto-generated service
// --------------------
export const { useLookupUserMutation, useGetUsersByIdsQuery } = contactsApi;
