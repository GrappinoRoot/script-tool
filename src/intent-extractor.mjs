// =========================
// INTENT EXTRACTOR - user request → { intent, parameters }
// =========================
// The only model call on the fast path: it classifies the request and extracts its
// variables. The catalog of known skills is part of the prompt so the model reuses an
// already registered intent instead of coining a new one for the same procedure.
// Anything going wrong (model offline, invalid JSON) returns null: the caller simply
// continues with its normal path.
import { resolveIdentifiers } from "./identifiers.mjs";

export const INTENT_RESPONSE_FORMAT = {
    type: "object",
    properties: {
        intent: { type: "string" },
        parameters: { type: "object" }
    },
    required: ["intent", "parameters"]
};

const VALID_INTENT = /^[a-z][a-z0-9_]*$/;

/** Neutral example: callers pass their own through the `examples` option. */
export const DEFAULT_EXAMPLES = [
    { request: "Find the customer named Acme", intent: "find_customer", parameters: { name: "Acme" } }
];

/**
 * Builds the extraction prompt.
 * @param {{ knownSkills?: Array<{intent: string, description?: string, parameters?: string[]}>,
 *           domainHint?: string, examples?: Array<{request: string, intent: string, parameters: object}> }} options
 * @returns {string}
 */
export function buildIntentPrompt({ knownSkills = [], domainHint = "", examples = DEFAULT_EXAMPLES } = {}) {
    const catalog = knownSkills.length
        ? knownSkills.map(s => `- ${s.intent}(${(s.parameters ?? []).join(", ")}): ${s.description ?? ""}`).join("\n")
        : "(no procedure registered yet)";

    const domain = domainHint ? ` The requests concern ${domainHint}.` : "";
    const examplesBlock = examples.map(e => `Request: ${e.request}\n${JSON.stringify({ intent: e.intent, parameters: e.parameters })}`).join("\n\n");

    return `You classify user requests.${domain} Reply with JSON only: {"intent": "...", "parameters": {...}}.

RULES:
1. "intent" is a snake_case verb_object name describing the task type (e.g. find_account, create_task_for_account).
2. If the request matches one of the known procedures below, reuse its exact intent name and fill its parameters.
3. "parameters" holds the values taken literally from the request (record names, subjects, quantities), never invented ones.
4. Parameter values must be copied verbatim from the request text, without quotes or extra words.
5. Do not add commentary.

KNOWN PROCEDURES:
${catalog}

EXAMPLES
${examplesBlock}`;
}

/**
 * Strips what the model added around a parameter value: surrounding quotes, and words
 * around an identifier ("Opportunity 006Qy..." → "006Qy..."). Without this the value does
 * not match what actually reached the tool arguments, and the procedure cannot be compiled.
 * @param {string|number|boolean} value
 * @param {{ find?: Function }} [identifiers] recognition rule (default: neutral heuristic)
 * @returns {string|number|boolean}
 */
export function normalizeParameterValue(value, identifiers) {
    if (typeof value !== "string") return value;
    let text = value.trim();
    const quoted = text.match(/^(["'])(.*)\1$/s);
    if (quoted) text = quoted[2].trim();

    const id = resolveIdentifiers(identifiers).find(text);
    return id && id !== text ? id : text;
}

function normalizeParameters(raw, identifiers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entries = Object.entries(raw).filter(([key, value]) =>
        /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    );
    return Object.fromEntries(entries.map(([key, value]) => [key, normalizeParameterValue(value, identifiers)]));
}

/**
 * Extracts intent and parameters from the request.
 * @param {string} userMessage
 * @param {{ chat: (req: object) => Promise<{message?: {content?: string}}>, knownSkills?: Array, model?: string,
 *           domainHint?: string, examples?: Array, identifiers?: object, logger?: { warn?: Function } }} context
 * @returns {Promise<{ intent: string, parameters: object }|null>} null when nothing could be extracted
 */
export async function extractIntent(userMessage, { chat, knownSkills = [], model, domainHint, examples, identifiers, logger = console } = {}) {
    if (typeof chat !== "function" || !userMessage) return null;

    try {
        const response = await chat({
            // `model` only when set: an undefined key would override the caller's own default
            ...(model ? { model } : {}),
            messages: [
                { role: "system", content: buildIntentPrompt({ knownSkills, domainHint, examples }) },
                { role: "user", content: userMessage }
            ],
            format: INTENT_RESPONSE_FORMAT,
            think: false
        });

        const parsed = JSON.parse(response?.message?.content ?? "");
        const intent = String(parsed?.intent ?? "").trim().toLowerCase().replace(/\s+/g, "_");
        if (!VALID_INTENT.test(intent)) return null;

        const parameters = normalizeParameters(parsed?.parameters, identifiers);
        if (parameters === null) return null;

        return { intent, parameters };
    } catch (e) {
        logger?.warn?.(`intent-extractor: extraction failed (${e.message})`);
        return null;
    }
}
