import { test } from "node:test";
import assert from "node:assert/strict";
import { renderArgs, parseToolContent, getAtPath, escapeEmbedded, SkillParameterError } from "../src/runtime.mjs";

test("placeholder on its own: the value keeps its type", () => {
    assert.deepEqual(renderArgs({ limit: "{{howMany}}" }, { howMany: 3 }), { limit: 3 });
});

test("placeholder inside a string: value embedded with quote escaping", () => {
    const args = renderArgs(
        { query: "SELECT Id FROM Account WHERE Name = '{{name}}'" },
        { name: "O'Brien" }
    );
    assert.equal(args.query, "SELECT Id FROM Account WHERE Name = 'O\\'Brien'");
});

test("missing parameter → explicit error, never an 'undefined' string", () => {
    assert.throws(
        () => renderArgs({ query: "WHERE Name = '{{name}}'" }, {}),
        (e) => e instanceof SkillParameterError && /Missing parameter: name/.test(e.message)
    );
});

test("reference to an earlier step resolved by path", () => {
    const previous = [{ records: [{ Id: "001xx000003DGbTAAW" }] }];
    const args = renderArgs({ WhatId: { $from: { step: 0, path: "records.0.Id" } } }, {}, previous);
    assert.deepEqual(args, { WhatId: "001xx000003DGbTAAW" });
});

test("reference to a missing path → error (the skill fails instead of inventing an id)", () => {
    assert.throws(
        () => renderArgs({ WhatId: { $from: { step: 0, path: "records.5.Id" } } }, {}, [{ records: [] }]),
        SkillParameterError
    );
});

test("nested structures: arrays and objects are walked", () => {
    const args = renderArgs(
        { body: { Subject: "Follow up {{name}}", Tags: ["{{name}}", "fisso"] } },
        { name: "Acme" }
    );
    assert.deepEqual(args, { body: { Subject: "Follow up Acme", Tags: ["Acme", "fisso"] } });
});

test("parseToolContent: JSON → object, free text → string", () => {
    assert.deepEqual(parseToolContent([{ type: "text", text: '{"records":[{"Id":"001"}]}' }]), { records: [{ Id: "001" }] });
    assert.equal(parseToolContent([{ type: "text", text: "no records" }]), "no records");
    assert.equal(parseToolContent(undefined), null);
});

test("getAtPath and escapeEmbedded", () => {
    assert.equal(getAtPath({ a: [{ b: 7 }] }, "a.0.b"), 7);
    assert.equal(getAtPath({ a: 1 }, "a.b.c"), undefined);
    assert.equal(escapeEmbedded("a\\b'c"), "a\\\\b\\'c");
});

test("step reference inside a string (an id within a query)", () => {
    const previous = [{ records: [{ AccountId: "001Qy000022n1yZIAQ" }] }];
    const args = renderArgs(
        { q: "SELECT Id, Name FROM Account WHERE Id = '{{@0.records.0.AccountId}}' LIMIT 1" },
        {},
        previous
    );
    assert.equal(args.q, "SELECT Id, Name FROM Account WHERE Id = '001Qy000022n1yZIAQ' LIMIT 1");
});

test("unresolvable step reference → error inside a string too", () => {
    assert.throws(
        () => renderArgs({ q: "WHERE Id = '{{@0.records.0.AccountId}}'" }, {}, [{ records: [] }]),
        SkillParameterError
    );
});
