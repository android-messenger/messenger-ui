import type {FormEvent, ReactNode} from "react";
import type {UiText} from "@ory/client";

/** The card layout shared by the login / registration / verification / recovery / settings pages. */
export function AuthCard({title, onSubmit, children}: {title: string; onSubmit: (e: FormEvent<HTMLFormElement>) => void; children: ReactNode}) {
    return (
        <div className="min-h-dvh flex items-center justify-center bg-gray-200">
            <form onSubmit={onSubmit} className="bg-white p-6 rounded-xl shadow w-96 max-w-[calc(100vw-2rem)]">
                <h1 className="text-xl font-semibold mb-4">{title}</h1>
                {children}
            </form>
        </div>
    );
}

/** Kratos flow messages: errors red, the rest (e.g. "code sent") neutral. */
export function FlowMessages({messages}: {messages?: UiText[]}) {
    return (
        <>
            {messages?.map((m) => (
                <p key={m.id} className={`mb-2 text-sm ${m.type === "error" ? "text-red-600" : "text-gray-700"}`}>{m.text}</p>
            ))}
        </>
    );
}

export function Field({label, ...input}: {label: string} & React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <div className="mb-3">
            <label className="block text-sm font-medium mb-1">{label}</label>
            <input {...input} className="w-full border rounded px-3 py-2"/>
        </div>
    );
}

export function SubmitButton({busy, label, busyLabel}: {busy: boolean; label: string; busyLabel: string}) {
    return (
        <button disabled={busy} className="w-full py-2 rounded text-white bg-teal-950 hover:bg-teal-900 disabled:bg-gray-400">
            {busy ? busyLabel : label}
        </button>
    );
}
