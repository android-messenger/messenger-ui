export const anonimo = "Anonimo";
// Defensive against non-string values (e.g. a Kratos trait object) so a bad identity
// shape degrades to "not logged in" instead of throwing on .trim().
export const isNotLogged = (myId: unknown) => {
    const v = typeof myId === "string" ? myId : "";
    return !v.trim() || v === anonimo;
};