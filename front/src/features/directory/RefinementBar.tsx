import type {IdsConstraint, IdsRefinement} from "./idsApi.ts";

// RefinementBar renders the adaptive-search affordances: the applied breadcrumb
// constraints (removable chips) and the server's single "best next question"
// (docs/adaptive-search). Crucially it offers ONLY the values that actually occur
// in the current candidate set — e.g. the two surname initials present, each with
// its count — never the whole alphabet, so every choice really narrows the list.
export function RefinementBar({
    constraints,
    refinement,
    onApply,
    onRemove,
}: {
    constraints: IdsConstraint[];
    refinement?: IdsRefinement;
    onApply: (c: IdsConstraint) => void;
    onRemove: (field: string) => void;
}) {
    const options = refinement?.options ?? [];
    const hasSuggestion = !!refinement && options.length > 0;
    if (constraints.length === 0 && !hasSuggestion) return null;

    const isLetterish = refinement?.input === "letter" || refinement?.input === "letters2";
    const display = (v: string) => (isLetterish ? v.toUpperCase() : v);

    return (
        <div className="flex flex-col gap-2">
            {constraints.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {constraints.map((c) => (
                        <button
                            key={c.field}
                            type="button"
                            onClick={() => onRemove(c.field)}
                            title="Remove filter"
                            className="inline-flex items-center gap-1 text-xs bg-teal-50 text-teal-800
                            border border-teal-200 rounded-full px-2 py-0.5 hover:bg-teal-100"
                        >
                            <span className="opacity-70">{prettyField(c.field)}:</span>
                            <span className="font-medium uppercase">{display(c.value)}</span>
                            <span className="ml-0.5 opacity-60">✕</span>
                        </button>
                    ))}
                </div>
            )}

            {hasSuggestion && refinement && (
                <div className="flex flex-col gap-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                    <span className="text-xs text-gray-600">{refinement.label}</span>
                    <div className="flex flex-wrap gap-1.5">
                        {options.map((o) => (
                            <button
                                key={o.value}
                                type="button"
                                onClick={() => onApply({field: refinement.field, value: o.value})}
                                className="inline-flex items-center gap-1 text-sm rounded-lg border border-gray-300
                                px-2 py-1 hover:bg-teal-600 hover:text-white transition"
                            >
                                <span className="font-medium">{display(o.value)}</span>
                                <span className="text-[10px] opacity-60">{o.count}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// prettyField turns a discriminator id into a short human label for a breadcrumb
// chip, e.g. "surname.initial" -> "surname", "email.domain" -> "email domain".
function prettyField(field: string): string {
    return field.replace(/\.initial$|\.prefix_2$/, "").replace(/[._]/g, " ").trim();
}
