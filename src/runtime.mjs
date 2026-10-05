// =========================
// SKILL RUNTIME - helpers imported by the generated skills
// =========================
// A compiled skill contains NO model-written code: it holds the list of recorded steps
// (tool + arguments with placeholders) and uses these functions to compute the real
// arguments from the request parameters and from earlier step results. No eval, no
// hand-rolled string interpolation.
//
// Placeholder language:
//   "{{name}}"                      → the whole value is the `name` parameter (type preserved)
//   "... '{{name}}' ..."            → parameter embedded in a larger string (quotes escaped)
//   "... '{{@0.records.0.Id}}' ..." → value read from step 0's result (typically an id inside a query)
//   { "$from": { step, path } }     → same, when it is the entire argument value

const PLACEHOLDER_NAME = "[A-Za-z0-9_@.]+";
const PLACEHOLDER = new RegExp(`\\{\\{\\s*(${PLACEHOLDER_NAME})\\s*\\}\\}`, "g");
const EXACT_PLACEHOLDER = new RegExp(`^\\{\\{\\s*(${PLACEHOLDER_NAME})\\s*\\}\\}$`);

/** A placeholder could not be resolved: missing parameter or unknown path. */
export class SkillParameterError extends Error {}

/**
 * Escapes a value interpolated into a larger string (typically a query): a quote inside
 * the value must not break — or alter — the surrounding statement.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeEmbedded(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Normalizes a tool result into a JS value: parsed JSON when possible, the concatenated
 * text otherwise. Used both at compile time and at run time, so the paths recorded by the
 * compiler still resolve when the skill runs.
 * @param {Array<{type?: string, text?: string}>|string|undefined} content
 * @returns {unknown}
 */
export function parseToolContent(content) {
    if (content == null) return null;
    const text = typeof content === "string"
        ? content
        : Array.isArray(content) ? content.map(part => part?.text ?? "").join("\n") : String(content);
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Reads a nested value through a dotted path ("records.0.Id").
 * @param {unknown} value
 * @param {string} dottedPath
 * @returns {unknown} undefined when the path does not exist
 */
export function getAtPath(value, dottedPath) {
    if (!dottedPath) return value;
    let current = value;
    for (const key of String(dottedPath).split(".")) {
        if (current == null || typeof current !== "object") return undefined;
        current = Array.isArray(current) ? current[Number(key)] : current[key];
    }
    return current;
}

function resolveStepReference({ step, path: dottedPath }, stepResults) {
    const source = stepResults?.[step];
    if (source === undefined) {
        throw new SkillParameterError(`Reference to step ${step} is not available`);
    }
    const value = getAtPath(source, dottedPath);
    if (value === undefined) {
        throw new SkillParameterError(`Path "${dottedPath}" not found in the result of step ${step}`);
    }
    return value;
}

/** Resolves one placeholder: a request parameter, or `@step.path` on an earlier step. */
function resolvePlaceholder(name, params, stepResults) {
    if (name.startsWith("@")) {
        const [step, ...rest] = name.slice(1).split(".");
        return resolveStepReference({ step: Number(step), path: rest.join(".") }, stepResults);
    }
    const value = params?.[name];
    if (value === undefined) throw new SkillParameterError(`Missing parameter: ${name}`);
    return value;
}

function resolveString(text, params, stepResults) {
    const exact = text.match(EXACT_PLACEHOLDER);
    if (exact) return resolvePlaceholder(exact[1], params, stepResults); // type preserved
    return text.replace(PLACEHOLDER, (_match, name) => escapeEmbedded(resolvePlaceholder(name, params, stepResults)));
}

/**
 * Computes the real arguments of a step, resolving placeholders and step references.
 * @param {unknown} template arguments as recorded at compile time
 * @param {object} params values extracted from the request
 * @param {Array<unknown>} stepResults normalized results of the earlier steps
 * @returns {unknown}
 * @throws {SkillParameterError} when a parameter is missing or a reference does not resolve
 */
export function renderArgs(template, params = {}, stepResults = []) {
    if (typeof template === "string") return resolveString(template, params, stepResults);
    if (Array.isArray(template)) return template.map(item => renderArgs(item, params, stepResults));
    if (template && typeof template === "object") {
        if (template.$from) return resolveStepReference(template.$from, stepResults);
        return Object.fromEntries(
            Object.entries(template).map(([key, value]) => [key, renderArgs(value, params, stepResults)])
        );
    }
    return template;
}
