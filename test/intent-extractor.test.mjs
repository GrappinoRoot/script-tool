import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { extractIntent, buildIntentPrompt, normalizeParameterValue } from "../src/intent-extractor.mjs";

const reply = (content) => mock.fn(async () => ({ message: { content } }));

test("valid response → intent and parameters", async () => {
    const chat = reply('{"intent":"find_account","parameters":{"name":"Acme"}}');
    const result = await extractIntent("Trova l'Account chiamato Acme", { chat });
    assert.deepEqual(result, { intent: "find_account", parameters: { name: "Acme" } });
});

test("intent normalized (case and spaces) to snake_case", async () => {
    const chat = reply('{"intent":"Find Account","parameters":{}}');
    assert.equal((await extractIntent("x", { chat })).intent, "find_account");
});

test("malformed JSON or empty intent → null: the agent carries on normally", async () => {
    assert.equal(await extractIntent("x", { chat: reply("non è json") }), null);
    assert.equal(await extractIntent("x", { chat: reply('{"intent":"","parameters":{}}') }), null);
    assert.equal(await extractIntent("x", { chat: reply('{"intent":"ok","parameters":["a"]}') }), null);
});

test("unreachable model → null, no exception propagated", async () => {
    const chat = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    assert.equal(await extractIntent("x", { chat }), null);
});

test("non-scalar parameters dropped (no invented objects in the arguments)", async () => {
    const chat = reply('{"intent":"find_account","parameters":{"name":"Acme","filtro":{"x":1},"limit":3}}');
    const { parameters } = await extractIntent("x", { chat });
    assert.deepEqual(parameters, { name: "Acme", limit: 3 });
});

test("empty request or missing chat → no model call", async () => {
    const chat = reply("{}");
    assert.equal(await extractIntent("", { chat }), null);
    assert.equal(await extractIntent("x", {}), null);
    assert.equal(chat.mock.callCount(), 0);
});

test("the known-skills catalog reaches the prompt (so an existing intent is reused)", () => {
    const prompt = buildIntentPrompt({ knownSkills: [{ intent: "find_account", description: "Trova un account", parameters: ["name"] }] });
    assert.match(prompt, /find_account\(name\): Trova un account/);
    assert.match(buildIntentPrompt(), /no procedure registered yet/);
});

test("the request is passed to the model as a user message", async () => {
    const chat = reply('{"intent":"find_account","parameters":{}}');
    await extractIntent("Cerca l'Account United Oil", { chat, knownSkills: [] });
    const [request] = chat.mock.calls[0].arguments;
    assert.equal(request.messages.at(-1).content, "Cerca l'Account United Oil");
    assert.equal(request.messages[0].role, "system");
});

test("without an explicit model the key is absent from the request (it must not override the caller's default)", async () => {
    const chat = reply('{"intent":"find_account","parameters":{}}');
    await extractIntent("x", { chat });
    assert.equal("model" in chat.mock.calls[0].arguments[0], false);

    await extractIntent("x", { chat, model: "qwen3.5:9b" });
    assert.equal(chat.mock.calls[1].arguments[0].model, "qwen3.5:9b");
});

test("domain and examples are injectable: the prompt names no product unless you say so", () => {
    assert.doesNotMatch(buildIntentPrompt(), /Salesforce/);
    assert.match(
        buildIntentPrompt({ domainHint: "Salesforce (SOQL, sObject, record Id)", examples: [{ request: "Trova l'Account Acme", intent: "find_account", parameters: { name: "Acme" } }] }),
        /requests concern Salesforce[\s\S]*find_account/
    );
});

test("values cleaned up: quotes and words around an identifier (otherwise they match no argument)", async () => {
    const chat = reply('{"intent":"create_task_for_opportunity","parameters":{"opportunity_id":"Opportunity 006Qy00000RoX4eIAF","industry":"\'Energy\'"}}');
    const { parameters } = await extractIntent("x", { chat });
    assert.deepEqual(parameters, { opportunity_id: "006Qy00000RoX4eIAF", industry: "Energy" });
});

test("identifier rule is injectable: without one, the neutral heuristic applies", () => {
    const soloIdCorti = { find: (text) => text.match(/\bID-\d+\b/)?.[0] ?? null };
    assert.equal(normalizeParameterValue("ordine ID-42", soloIdCorti), "ID-42");
    assert.equal(normalizeParameterValue("ordine 006Qy00000RoX4eIAF", soloIdCorti), "ordine 006Qy00000RoX4eIAF");
});

test("normalizeParameterValue leaves legitimate names untouched", () => {
    assert.equal(normalizeParameterValue("United Oil & Gas Corp."), "United Oil & Gas Corp.");
    assert.equal(normalizeParameterValue("O'Brien"), "O'Brien");
    assert.equal(normalizeParameterValue(3), 3);
});
