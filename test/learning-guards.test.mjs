import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createProceduralMemory, mutationVerifier, impliesMutation, REGISTRY_FILE } from "../src/index.mjs";

const RUNTIME_IMPORT = new URL("../src/runtime.mjs", import.meta.url).href;
const SILENT = { warn: () => {} };

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "procedural-memory-guards-"));
const chatReplying = (content) => mock.fn(async () => ({ message: { content } }));
const json = (value) => [{ type: "text", text: JSON.stringify(value) }];
const readRegistry = (root) => JSON.parse(fs.readFileSync(path.join(root, REGISTRY_FILE), "utf8"));

function memoryWith(root, intentJson, options = {}) {
    return createProceduralMemory({
        root, chat: chatReplying(intentJson), runtimeImport: RUNTIME_IMPORT, logger: SILENT, ...options
    });
}

// The real case: both requests classify as query_accounts_with_field_value with the same
// parameters, because what the second one asks for on top ("and its Contacts") is not
// represented by any parameter. Only the tool set tells them apart.
const ACCOUNTS_INTENT = '{"intent":"query_accounts_with_field_value","parameters":{"field_name":"Industry","value":"Energy"}}';
const ACCOUNTS_QUERY = { query: "SELECT Id, Name FROM Account WHERE Industry = 'Energy'" };
const ACCOUNTS_RESULT = json({ records: [{ Id: "001Qy00000AbCdEfGHI", Name: "United Oil & Gas Corp." }] });

async function teachAccountsSkill(memory) {
    const task = await memory.resolve("trova gli account con Industry Energy");
    task.record({ tool: "soqlQuery", args: ACCOUNTS_QUERY, ok: true, content: ACCOUNTS_RESULT });
    task.recordFinalAnswer("Ho trovato 1 account.");
    return memory.learn(task);
}

// =========================
// Guard 1: a failed skill is not replaced by a procedure doing another job
// =========================

test("learn() refuses to replace a registered skill when the new procedure uses different tools", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, ACCOUNTS_INTENT);

    assert.ok((await teachAccountsSkill(memory)).saved, "the first run teaches the skill");

    // Use it once, so the entry carries metrics worth protecting
    const replay = await memory.resolve("trova gli account con Industry Energy");
    await memory.run(replay, { callTool: async () => ({ ok: true, content: ACCOUNTS_RESULT }) });

    const scriptPath = path.join(root, "query_accounts_with_field_value.mjs");
    const scriptBefore = fs.readFileSync(scriptPath, "utf8");

    // A richer request lands on the same intent, the skill fails, the agent solves it
    const second = await memory.resolve("l'Account United Oil & Gas Corp. e nome ed email del suo Contact principale");
    assert.ok(second.skill, "the intent is already registered");
    second.record({ tool: "soqlQuery", args: ACCOUNTS_QUERY, ok: true, content: ACCOUNTS_RESULT });
    second.record({
        tool: "getRelatedRecords",
        args: { parentId: { $from: { step: 0, path: "records.0.Id" } }, relationship: "Contacts" },
        ok: true,
        content: json({ records: [{ Name: "Mario Rossi", Email: "mario@example.com" }] })
    });
    second.recordFinalAnswer("Contact principale: Mario Rossi, mario@example.com.");

    const relearned = memory.learn(second);

    assert.equal(relearned.saved, null, "nothing is saved");
    assert.match(relearned.reason, /different tools \(soqlQuery vs soqlQuery, getRelatedRecords\)/);

    const registry = readRegistry(root);
    assert.equal(registry.skills.length, 1, "still one skill");
    assert.deepEqual(registry.skills[0].tools, ["soqlQuery"], "the registered procedure is untouched");
    assert.equal(registry.skills[0].description, "Learned from: trova gli account con Industry Energy");
    assert.equal(registry.skills[0].runs, 1, "its metrics survive");
    assert.equal(fs.readFileSync(scriptPath, "utf8"), scriptBefore, "the script on disk is not rewritten");
});

test("learn() does replace a registered skill when the tools match: that is a repair", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, ACCOUNTS_INTENT);

    assert.ok((await teachAccountsSkill(memory)).saved);

    // Same tool, different arguments: the field was renamed, the procedure must be fixed
    const second = await memory.resolve("trova gli account con Industry Energy");
    assert.ok(second.skill);
    second.record({
        tool: "soqlQuery",
        args: { query: "SELECT Id, Name FROM Account WHERE Industry__c = 'Energy'" },
        ok: true,
        content: ACCOUNTS_RESULT
    });
    second.recordFinalAnswer("Ho trovato 1 account.");

    const relearned = memory.learn(second);

    assert.ok(relearned.saved, "the repair is accepted");
    const registry = readRegistry(root);
    assert.equal(registry.skills.length, 1);
    // The value is parameterized back out, so the renamed field shows as {{field_name}}__c
    assert.match(fs.readFileSync(path.join(root, "query_accounts_with_field_value.mjs"), "utf8"), /\{\{field_name\}\}__c/);
});

test("learn() with no skill registered for the intent behaves as before", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, ACCOUNTS_INTENT);

    const learned = await teachAccountsSkill(memory);

    assert.ok(learned.saved);
    assert.deepEqual(learned.saved.tools, ["soqlQuery"]);
});

// =========================
// Guard 2: verify / mutationVerifier
// =========================

const CONTACT_INTENT = '{"intent":"create_contact","parameters":{"lastName":"Rossi"}}';
const isMutation = (tool) => tool === "createSobjectRecord";

function createContactRun(memory, steps) {
    return memory.resolve("crea un contatto Rossi").then(task => {
        for (const step of steps) task.record(step);
        task.recordFinalAnswer("Fatto.");
        return task;
    });
}

const READ_STEPS = [
    { tool: "soqlQuery", args: { query: "SELECT Id FROM Contact WHERE LastName = 'Rossi'" }, ok: true, content: json({ records: [] }) },
    { tool: "getObjectSchema", args: { sobject: "Contact" }, ok: true, content: json({ fields: ["FirstName", "LastName"] }) }
];
const WRITE_STEP = {
    tool: "createSobjectRecord",
    args: { sobject: "Contact", values: { LastName: "Rossi" } },
    ok: true,
    content: json({ id: "003Qy00000AbCdEfGHI" })
};

test("mutationVerifier refuses a create_ run in which nothing was created", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT, { verify: mutationVerifier({ isMutation }) });

    const learned = memory.learn(await createContactRun(memory, READ_STEPS));

    assert.equal(learned.saved, null);
    assert.equal(
        learned.reason,
        "intent 'create_contact' implies a change but no mutating tool ran: the task was not performed"
    );
    assert.equal(fs.existsSync(path.join(root, REGISTRY_FILE)), false, "nothing is written");
});

test("mutationVerifier admits the run when a mutating tool really ran", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT, { verify: mutationVerifier({ isMutation }) });

    const learned = memory.learn(await createContactRun(memory, [READ_STEPS[0], WRITE_STEP]));

    assert.ok(learned.saved);
    assert.ok(learned.saved.tools.includes("createSobjectRecord"));
});

test("mutationVerifier refuses when the only mutating tool failed", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT, { verify: mutationVerifier({ isMutation }) });

    const failedWrite = { ...WRITE_STEP, ok: false, content: json({ error: "REQUIRED_FIELD_MISSING" }) };
    const learned = memory.learn(await createContactRun(memory, [READ_STEPS[0], failedWrite]));

    assert.equal(learned.saved, null, "a write that failed changed nothing either");
    assert.match(learned.reason, /no mutating tool ran/);
});

test("mutationVerifier leaves read-only intents alone", async () => {
    const root = tempRoot();
    const memory = memoryWith(
        root,
        '{"intent":"find_account","parameters":{"name":"Acme"}}',
        { verify: mutationVerifier({ isMutation }) }
    );

    const task = await memory.resolve("trova l'account Acme");
    task.record({
        tool: "soqlQuery",
        args: { query: "SELECT Id FROM Account WHERE Name = 'Acme'" },
        ok: true,
        content: ACCOUNTS_RESULT
    });
    task.recordFinalAnswer("Trovato.");

    assert.ok(memory.learn(task).saved);
});

test("without verify, the same empty create_contact run is still learned: the rule is opt-in", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT);

    const learned = memory.learn(await createContactRun(memory, READ_STEPS));

    assert.ok(learned.saved, "today's behaviour is unchanged for whoever does not configure verify");
    assert.deepEqual(learned.saved.tools, ["soqlQuery", "getObjectSchema"]);
});

test("a verify that refuses hands its own reason back", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT, {
        verify: ({ intent, steps, skill }) => {
            assert.equal(intent, "create_contact");
            assert.deepEqual(steps.map(s => s.tool), ["soqlQuery", "getObjectSchema"], "only the successful steps");
            assert.equal(skill, null, "no skill registered yet");
            return { ok: false, reason: "not on my watch" };
        }
    });

    assert.deepEqual(memory.learn(await createContactRun(memory, READ_STEPS)), { saved: null, reason: "not on my watch" });
});

test("a verify that throws fails closed instead of letting the run through", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT, {
        verify: () => { throw new Error("verifier is down"); }
    });

    const learned = memory.learn(await createContactRun(memory, [READ_STEPS[0], WRITE_STEP]));

    assert.equal(learned.saved, null);
    assert.equal(learned.reason, "verify failed: verifier is down");
});

// A generic tool writes or not depending on its arguments, not on its name: that is why
// isMutation receives them.
const isWriteCall = (tool, args) => tool === "restCall" && ["POST", "PATCH", "DELETE"].includes(args?.method);

test("mutationVerifier refuses when the generic tool was only used to read", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT, { verify: mutationVerifier({ isMutation: isWriteCall }) });

    const read = {
        tool: "restCall",
        args: { method: "GET", path: "/services/data/v62.0/query?q=LastName+%3D+'Rossi'" },
        ok: true,
        content: json({ records: [] })
    };

    const learned = memory.learn(await createContactRun(memory, [read]));

    assert.equal(learned.saved, null, "same tool, but no write happened");
    assert.match(learned.reason, /no mutating tool ran/);
});

test("mutationVerifier admits the same tool when its arguments make it a write", async () => {
    const root = tempRoot();
    const memory = memoryWith(root, CONTACT_INTENT, { verify: mutationVerifier({ isMutation: isWriteCall }) });

    const write = {
        tool: "restCall",
        args: { method: "POST", path: "/services/data/v62.0/sobjects/Contact", body: { LastName: "Rossi" } },
        ok: true,
        content: json({ id: "003Qy00000AbCdEfGHI" })
    };

    const learned = memory.learn(await createContactRun(memory, [write]));

    assert.ok(learned.saved, "the arguments identify it as a write");
    assert.deepEqual(learned.saved.tools, ["restCall"]);
});

test("mutationVerifier requires isMutation: only the host knows which tools write", () => {
    assert.throws(() => mutationVerifier(), /isMutation/);
    assert.throws(() => mutationVerifier({ isMutation: "yes" }), /isMutation/);
});

test("impliesMutation recognizes the verb, with or without a suffix", () => {
    for (const intent of ["create_contact", "delete", "send_email", "assign_owner", "Update_Record"]) {
        assert.equal(impliesMutation(intent), true, intent);
    }
    for (const intent of ["find_account", "query_accounts", "created_report", "settle_invoice", ""]) {
        assert.equal(impliesMutation(intent), false, intent);
    }
});
