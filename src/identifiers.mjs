// =========================
// IDENTIFIERS - spotting opaque identifiers inside tool arguments
// =========================
// An identifier (a record id, a foreign key) baked into a skill would make it useless:
// the skill would always operate on the same object. The compiler must therefore be able
// to recognize them — but every domain has its own format, so the caller passes its own
// rule through the `identifiers` option.
//
// The default below is a neutral heuristic: an alphanumeric token of at least 12
// characters containing both letters and digits (a generated id, not a word). It does not
// know your format: if you do, replace it.

const GENERIC_IDENTIFIER = /\b[A-Za-z0-9]{12,}\b/g;

function isGenericIdentifier(token) {
    return /\d/.test(token) && /[A-Za-z]/.test(token);
}

export const defaultIdentifiers = {
    /**
     * First identifier contained in the text.
     * @param {string} text
     * @returns {string|null}
     */
    find(text) {
        for (const [token] of String(text).matchAll(GENERIC_IDENTIFIER)) {
            if (isGenericIdentifier(token)) return token;
        }
        return null;
    },

    /**
     * Replaces every identifier contained in the text.
     * @param {string} text
     * @param {(id: string) => string} replacer
     * @returns {string}
     */
    replace(text, replacer) {
        return String(text).replace(GENERIC_IDENTIFIER, (token) => isGenericIdentifier(token) ? replacer(token) : token);
    }
};

/**
 * Merges the caller's rule with the default (you may override only `find` or only `replace`).
 * @param {{ find?: Function, replace?: Function }} [identifiers]
 * @returns {{ find: Function, replace: Function }}
 */
export function resolveIdentifiers(identifiers) {
    return { ...defaultIdentifiers, ...identifiers };
}
