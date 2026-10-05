// Type-level test: it does not run, it must compile. If the .mjs sources and the .d.ts
// declarations drift apart, `npm run typecheck` fails here.
import {
    createProceduralMemory,
    compileProcedure,
    createRecorder,
    isSuccessfulRun,
    findSkill,
    runSkill,
    renderArgs,
    mutationVerifier,
    impliesMutation,
    MUTATION_VERBS,
    type CallTool,
    type Chat,
    type Task,
    type HandleResult,
    type SkillDefinition,
    type Verify,
    type VerifyResult
} from "@script-flow/procedural-memory";

// --- the shapes a host provides ---------------------------------------------
const chat: Chat = async () => ({ message: { content: '{"intent":"find_customer","parameters":{"name":"Acme"}}' } });

const callTool: CallTool = async (tool, args) => ({
    ok: true,
    content: [{ type: "text", text: JSON.stringify({ tool, args }) }]
});

const memory = createProceduralMemory({
    root: ".agents/procedural-skills",
    chat,
    domainHint: "a customer API",
    examples: [{ request: "Find the customer named Acme", intent: "find_customer", parameters: { name: "Acme" } }],
    identifiers: {
        find: (text) => text.match(/\b[a-z0-9]{12,}\b/)?.[0] ?? null,
        replace: (text, replacer) => text.replace(/\b[a-z0-9]{12,}\b/g, replacer)
    },
    logger: { warn: (message) => console.warn(message) }
});

// --- learning guards --------------------------------------------------------
const writeTools = new Set(["createRecord", "updateRecord"]);
const ready: Verify = mutationVerifier({ isMutation: (tool) => writeTools.has(tool) });

// A generic tool: the arguments decide, not the name. Both forms must keep compiling.
const byArgs: Verify = mutationVerifier({
    isMutation: (tool, args) => tool === "restCall" && args.method === "POST"
});

const custom: Verify = ({ intent, steps, skill }): VerifyResult => {
    const touched: string[] = steps.map((step) => step.tool);
    const previous: SkillDefinition | null = skill;
    return impliesMutation(intent) && !touched.length
        ? { ok: false, reason: `${intent} did nothing (was: ${previous?.intent ?? "new"})` }
        : { ok: true, reason: "" };
};

const verbs: readonly string[] = MUTATION_VERBS;

createProceduralMemory({ root: ".agents/procedural-skills", chat, verify: verbs.length ? ready : byArgs });
createProceduralMemory({ root: ".agents/procedural-skills", chat, verify: custom });

// --- one-call flow ----------------------------------------------------------
const handled: HandleResult<string> = await memory.handle<string>("Find the customer named Acme", {
    callTool,
    agent: async ({ callTool, task }) => {
        const result = await callTool("httpGet", { url: "https://api.example.com/customers?name=Acme" });
        return result.ok ? `done ${task.intent}` : "failed";
    }
});

const source: "skill" | "agent" = handled.source;
const output: string | undefined = handled.output;

// --- step-by-step flow ------------------------------------------------------
const task: Task = await memory.resolve("Find the customer named Acme");
const skill: SkillDefinition | null = task.skill;

if (skill) {
    const run = await memory.run(task, { callTool });
    const ok: boolean = run.ok;
    void ok;
} else {
    const recording = memory.instrument(task, callTool);
    await recording("httpGet", { url: "https://api.example.com/customers?name=Acme" });
    task.recordSkipped({ tool: "httpDelete", reason: "denied by the user" });
    task.recordFinalAnswer("Found Acme.");
    const learned = memory.learn(task);
    const savedName: string | undefined = learned.saved?.intent;
    void savedName;
}

// --- lower-level API --------------------------------------------------------
const recorder = createRecorder("Find the customer named Acme");
recorder.recordToolCall({ tool: "httpGet", args: { url: "x" }, ok: true, content: [{ type: "text", text: "{}" }] });
recorder.recordFinalAnswer("done");

const trace = recorder.getTrace();
const check: { ok: boolean; reason: string } = isSuccessfulRun(trace);

const compiled = compileProcedure({ intent: "find_customer", parameters: { name: "Acme" }, trace });
if (compiled.ok) {
    const definition: SkillDefinition = compiled.definition;
    void definition.script;
} else {
    const reason: string = compiled.reason;
    void reason;
}

const found = findSkill("find_customer", ".agents/procedural-skills");
if (found) await runSkill(found, { name: "Globex" }, { callTool, root: ".agents/procedural-skills" });

const args = renderArgs({ q: "name = '{{name}}'" }, { name: "Acme" }, [{ records: [] }]);

void source; void output; void check; void args; void memory.skills();
