import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createProceduralMemory, DEFAULT_RUNTIME_IMPORT } from "../src/index.mjs";

const RUNTIME_IMPORT = new URL("../src/runtime.mjs", import.meta.url).href;
const SILENT = { warn: () => {} };

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "procedural-memory-"));
const chatReplying = (content) => mock.fn(async () => ({ message: { content } }));
const json = (value) => [{ type: "text", text: JSON.stringify(value) }];

function memoryWith(root, intentJson) {
    return createProceduralMemory({ root, chat: chatReplying(intentJson), runtimeImport: RUNTIME_IMPORT, logger: SILENT });
}

test("full cycle, nothing domain-specific: the first request teaches, the second reuses", async () => {
    const root = tempRoot();

    // --- request 1: no known procedure, the application solves it and records what it did
    const first = await memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Acme"}}')
        .resolve("Find the customer named Acme");
    assert.equal(first.skill, null, "empty registry: no skill");

    first.record({
        tool: "httpGet",
        args: { url: "https://api.example.com/customers?name=Acme" },
        ok: true,
        content: json({ results: [{ id: "cus-001", name: "Acme" }] })
    });
    first.recordFinalAnswer("Ho trovato il cliente Acme.");

    const learned = memoryWith(root, "{}").learn(first);
    assert.equal(learned.saved.intent, "find_customer");
    assert.deepEqual(learned.saved.parameters, ["name"]);

    // --- request 2: same procedure, different parameter → direct execution
    const memory = memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Globex"}}');
    const second = await memory.resolve("Find the customer named Globex");
    assert.ok(second.skill, "the learned skill must be found");

    const callTool = mock.fn(async () => ({ ok: true, content: json({ results: [{ id: "cus-002", name: "Globex" }] }) }));
    const result = await memory.run(second, { callTool });

    assert.equal(result.ok, true);
    assert.deepEqual(callTool.mock.calls[0].arguments, [
        "httpGet",
        { url: "https://api.example.com/customers?name=Globex" }
    ]);
    assert.equal(memory.skills()[0].intent, "find_customer");
});

test("learn records nothing when the run did not succeed", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Acme"}}');

    const task = await memory.resolve("Find the customer named Acme");
    task.recordSkipped({ tool: "httpGet", reason: "negato dall'utente" });

    assert.deepEqual(memory.learn(task).saved, null);
    assert.equal(memory.skills().length, 0);
});

test("no intent extracted (model offline or invalid JSON) → no skill and no error", async () => {
    const root = tempRoot();
    const memory = createProceduralMemory({
        root,
        chat: async () => { throw new Error("ECONNREFUSED"); },
        logger: SILENT
    });

    const task = await memory.resolve("Find the customer named Acme");
    assert.equal(task.intent, null);
    assert.equal(task.skill, null);
    assert.match(memory.learn(task).reason, /no intent/);
});

test("opaque identifier that comes from nowhere → the procedure is not registered", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, '{"intent":"update_customer","parameters":{"name":"Acme"}}');

    const task = await memory.resolve("Update the customer named Acme");
    task.record({
        tool: "httpPost",
        args: { url: "https://api.example.com/customers/ab12cd34ef56gh", body: { name: "Acme" } },
        ok: true,
        content: json({ ok: true })
    });
    task.recordFinalAnswer("Aggiornato");

    const learned = memory.learn(task);
    assert.equal(learned.saved, null);
    assert.match(learned.reason, /ab12cd34ef56gh/);
});

test("root is required: better an immediate error than skills written somewhere random", () => {
    assert.throws(() => createProceduralMemory({ chat: async () => ({}) }), /root/);
});

test("generated scripts import the runtime from the package, not from a relative path", async () => {
    const root = tempRoot();
    const memory = createProceduralMemory({ root, chat: chatReplying('{"intent":"ping_service","parameters":{"host":"example.com"}}'), logger: SILENT });

    const task = await memory.resolve("Ping example.com");
    task.record({ tool: "ping", args: { host: "example.com" }, ok: true, content: json({ ok: true }) });
    task.recordFinalAnswer("ok");
    const { saved } = memory.learn(task);

    const source = fs.readFileSync(path.join(root, saved.script), "utf8");
    assert.equal(DEFAULT_RUNTIME_IMPORT, "@script-flow/procedural-memory/runtime");
    assert.match(source, /from "@script-flow\/procedural-memory\/runtime"/);
});

test("instrument records every tool call and returns the result unchanged", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Acme"}}');
    const task = await memory.resolve("Find the customer named Acme");

    const callTool = mock.fn(async () => ({ ok: true, content: json({ id: "cus-001" }) }));
    const recording = memory.instrument(task, callTool);

    const result = await recording("httpGet", { url: "https://api.example.com/customers?name=Acme" });

    assert.deepEqual(result, { ok: true, content: json({ id: "cus-001" }) }, "the caller sees its own result");
    const [step] = task.recorder.getTrace().steps;
    assert.equal(step.tool, "httpGet");
    assert.equal(step.ok, true);
    assert.deepEqual(step.args, { url: "https://api.example.com/customers?name=Acme" });
});

test("instrument records a throwing tool as failed and lets the exception through", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Acme"}}');
    const task = await memory.resolve("Find the customer named Acme");

    const recording = memory.instrument(task, async () => { throw new Error("ECONNRESET"); });

    await assert.rejects(() => recording("httpGet", { url: "x" }), /ECONNRESET/);
    assert.equal(task.recorder.getTrace().steps[0].ok, false);
});

test("handle: on a miss it runs your agent, learns, and on the next request replays the skill", async () => {
    const root = tempRoot();
    const agent = mock.fn(async ({ callTool }) => {
        await callTool("httpGet", { url: "https://api.example.com/customers?name=Acme" });
        return "Found Acme.";
    });

    const miss = await memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Acme"}}')
        .handle("Find the customer named Acme", { callTool: async () => ({ ok: true, content: json({ id: "cus-001" }) }), agent });

    assert.equal(miss.source, "agent");
    assert.equal(miss.output, "Found Acme.");
    assert.equal(miss.learned.saved.intent, "find_customer", miss.learned.reason);
    assert.equal(agent.mock.callCount(), 1);

    const callTool = mock.fn(async () => ({ ok: true, content: json({ id: "cus-002" }) }));
    const hit = await memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Globex"}}')
        .handle("Find the customer named Globex", { callTool, agent });

    assert.equal(hit.source, "skill");
    assert.equal(agent.mock.callCount(), 1, "the agent must not run again");
    assert.deepEqual(callTool.mock.calls[0].arguments[1], { url: "https://api.example.com/customers?name=Globex" });
});

test("handle: a failing skill falls back to your agent instead of failing the request", async () => {
    const root = tempRoot();
    const learn = await memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Acme"}}')
        .handle("Find the customer named Acme", {
            callTool: async () => ({ ok: true, content: json({ id: "cus-001" }) }),
            agent: async ({ callTool }) => {
                await callTool("httpGet", { url: "https://api.example.com/customers?name=Acme" });
                return "Found Acme.";
            }
        });
    assert.ok(learn.learned.saved);

    const agent = mock.fn(async () => "Recovered by the agent.");
    const result = await memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Globex"}}')
        .handle("Find the customer named Globex", { callTool: async () => ({ ok: false, content: json({ error: "500" }) }), agent });

    assert.equal(result.source, "agent");
    assert.equal(result.output, "Recovered by the agent.");
    assert.equal(agent.mock.callCount(), 1);
});

test("handle: nothing is learned when the agent gives no final answer", async () => {
    const root = tempRoot();
    const result = await memoryWith(root, '{"intent":"find_customer","parameters":{"name":"Acme"}}')
        .handle("Find the customer named Acme", {
            callTool: async () => ({ ok: true, content: json({ id: "cus-001" }) }),
            agent: async ({ callTool }) => { await callTool("httpGet", { url: "https://api.example.com?name=Acme" }); }
        });

    assert.equal(result.learned.saved, null);
    assert.match(result.learned.reason, /final answer/);
});

test("the facade keeps working when its methods are destructured", async () => {
    const root = tempRoot();
    const { handle } = memoryWith(root, '{"intent":"ping_service","parameters":{"host":"example.com"}}');

    const result = await handle("Ping example.com", {
        callTool: async () => ({ ok: true, content: json({ ok: true }) }),
        agent: async ({ callTool }) => { await callTool("ping", { host: "example.com" }); return "pong"; }
    });

    assert.equal(result.learned.saved.intent, "ping_service", result.learned.reason);
});
