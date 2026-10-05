// =========================
// SKILL REGISTRY - persistent catalog of compiled skills
// =========================
// On disk: <root>/registry.json (definitions + metrics) and <root>/<intent>.<ext> (the script).
// `root` is always explicit: the host project decides where its memory lives.
// Matching is by exact intent. Semantic matching is a later evolution; here a wrong intent
// must simply find nothing and let the agent do its job.
import fs from "fs";
import path from "path";

export const REGISTRY_FILE = "registry.json";

function requireRoot(root) {
    if (!root) throw new Error("skill-registry: 'root' is required (the skills directory)");
    return root;
}

function registryPath(root) {
    return path.join(requireRoot(root), REGISTRY_FILE);
}

/**
 * Reads the registry. A missing, unreadable or corrupted file means "no skills":
 * procedural memory is an optimization and must never break the agent.
 * @param {string} root
 * @returns {{ skills: Array<object> }}
 */
export function loadRegistry(root) {
    requireRoot(root); // outside the try: a missing root is a programming error, not an empty registry
    try {
        const parsed = JSON.parse(fs.readFileSync(registryPath(root), "utf8"));
        return { skills: Array.isArray(parsed.skills) ? parsed.skills : [] };
    } catch {
        return { skills: [] };
    }
}

function writeRegistry(root, registry) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(registryPath(root), JSON.stringify(registry, null, 2));
}

/**
 * Registered skills, without their code: this is the catalog fed to intent extraction.
 * @param {string} root
 * @returns {Array<{intent: string, description: string, parameters: string[]}>}
 */
export function listSkills(root) {
    return loadRegistry(root).skills.map(({ intent, description, parameters }) => ({
        intent, description, parameters: parameters ?? []
    }));
}

/**
 * Looks up a skill by intent (exact, case-insensitive).
 * @param {string} intent
 * @param {string} root
 * @returns {object|null}
 */
export function findSkill(intent, root) {
    if (!intent) return null;
    const wanted = String(intent).toLowerCase();
    const skill = loadRegistry(root).skills.find(s => String(s.intent).toLowerCase() === wanted);
    if (!skill) return null;
    // A definition whose script is gone is garbage: better no skill than a failing import.
    if (!fs.existsSync(path.join(root, skill.script))) return null;
    return skill;
}

/**
 * Saves (or replaces) a skill: writes the script and updates the registry.
 * @param {{ definition: object, source: string }} compiled the result of compileProcedure
 * @param {string} root
 * @returns {object} the stored definition
 */
export function saveSkill({ definition, source }, root) {
    const entry = { ...definition, runs: 0, failures: 0, lastRunAt: null };
    fs.mkdirSync(requireRoot(root), { recursive: true });
    fs.writeFileSync(path.join(root, entry.script), source);

    const registry = loadRegistry(root);
    registry.skills = [
        ...registry.skills.filter(s => String(s.intent).toLowerCase() !== String(entry.intent).toLowerCase()),
        entry
    ];
    writeRegistry(root, registry);
    return entry;
}

/**
 * Updates a skill's usage metrics (runs, failures, last use).
 * @param {string} intent
 * @param {{ ok: boolean, now?: () => Date }} outcome
 * @param {string} root
 */
export function recordUsage(intent, { ok, now = () => new Date() } = {}, root) {
    const registry = loadRegistry(root);
    const skill = registry.skills.find(s => String(s.intent).toLowerCase() === String(intent).toLowerCase());
    if (!skill) return;
    skill.runs = (skill.runs ?? 0) + 1;
    if (!ok) skill.failures = (skill.failures ?? 0) + 1;
    skill.lastRunAt = now().toISOString();
    writeRegistry(root, registry);
}
