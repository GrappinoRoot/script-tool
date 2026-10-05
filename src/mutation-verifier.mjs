// =========================
// MUTATION VERIFIER - ready-made check for the most common failure
// =========================
// A run can be structurally perfect and still not have done the job: the agent queries,
// reads a schema, then answers "which first name should I use?". isSuccessfulRun says ok,
// because nothing was blocked and an answer came back. Compiled, that becomes a
// `create_contact` skill that creates no contact and runs instead of the agent.
//
// The package cannot judge semantics, but it can check the intent's verb against the
// observed effects - provided the host says which of its tools change state.

/** Intent prefixes that promise a change. Exported so you can inspect or extend the list. */
export const MUTATION_VERBS = ["create", "update", "delete", "remove", "add", "set", "send", "assign"];

const MUTATION_INTENT = new RegExp(`^(${MUTATION_VERBS.join("|")})(_|$)`);

/**
 * True when the intent's verb promises a change (`create_contact`, `delete`, `send_email`).
 * @param {string} intent
 */
export function impliesMutation(intent) {
    return MUTATION_INTENT.test(String(intent ?? "").toLowerCase());
}

/**
 * Builds a `verify` function that refuses a run whose intent promises a change when no
 * mutating tool actually ran.
 *
 * @param {{ isMutation: (tool: string) => boolean }} options
 *   `isMutation` is yours because only you know your tools: the library never guesses which
 *   ones write. It is required - without it the check could say nothing at all.
 * @returns {({ intent: string, steps: Array }) => { ok: boolean, reason: string }}
 */
export function mutationVerifier({ isMutation } = {}) {
    if (typeof isMutation !== "function") {
        throw new Error("mutationVerifier: 'isMutation' is required (a tool name => boolean)");
    }

    return ({ intent, steps }) => {
        if (!impliesMutation(intent)) return { ok: true, reason: "" };
        // Only successful steps are passed in: a write that failed changed nothing either.
        if ((steps ?? []).some(step => isMutation(step.tool))) return { ok: true, reason: "" };

        return {
            ok: false,
            reason: `intent '${intent}' implies a change but no mutating tool ran: the task was not performed`
        };
    };
}
