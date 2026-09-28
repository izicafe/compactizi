import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMessages, decide, defaultThresholds, render, type DecisionResult, predicates, type CompactChunk } from "../src/core.js";
import { JevCompatibleProvider } from "../src/provider.js";
const task = { task: "Implement auth" };
function score(id: string, overrides: Partial<DecisionResult["probabilities"]>): DecisionResult {
  return { id, probabilities: { relevant_to_active_task: 0.1, contains_persistent_constraint: 0.1, contains_unresolved_work: 0.1, requires_exact_preservation: 0.1, useful_but_summarizable: 0.1, safe_to_drop: 0.1, ...overrides } };
}
const chunk = (id: string, content: string): CompactChunk => ({ id, kind: "user", content });
test("exact persistent user constraint survives unrelated current task", () => {
  const chunks = [chunk("old", "Never modify database schema."), chunk("new", "Implement auth")];
  const traces = decide(chunks, [score("old", { contains_persistent_constraint: 0.98 }), score("new", { relevant_to_active_task: 0.9 })]);
  assert.equal(traces[0].action, "KEEP_EXACT");
  assert.match(render(chunks, traces, new Map([["new", "Auth is pending"]]), task), /Never modify database schema\./);
});
test("obsolete build output is dropped only with strong negative evidence", () => {
  const c = chunk("build", "obsolete build output ".repeat(5000));
  assert.equal(decide([c], [score("build", { safe_to_drop: 0.99 })])[0].action, "DROP");
});
test("useful failing assertion is summarized, exact identifier preserved", () => {
  const chunks = [chunk("test", "lots of tests; assertion auth.status === 401 fails"), chunk("path", "src/auth/session.ts; function verifyToken")];
  const traces = decide(chunks, [score("test", { useful_but_summarizable: 0.9 }), score("path", { requires_exact_preservation: 0.95 })]);
  assert.deepEqual(traces.map(t => t.action), ["SUMMARIZE", "KEEP_EXACT"]);
  const text = render(chunks, traces, new Map([["test", "auth.status === 401 fails"]]), task);
  assert.match(text, /src\/auth\/session.ts; function verifyToken/);
  assert.match(text, /auth.status === 401 fails/);
});
test("uncertain answers never drop", () => {
  const c = chunk("u", "uncertain");
  const p = Object.fromEntries(predicates.map(k => [k, 0.5]));
  assert.equal(decide([c], [{ id: "u", probabilities: p as any }], defaultThresholds)[0].action, "SUMMARIZE");
});
test("related tool result retains its provenance", () => {
  const chunks = chunkMessages([{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }] }, { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "important result" }] }]);
  assert.deepEqual(chunks[1].relatedChunkIds, ["m0.0"]);
  const traces = decide(chunks, [score("m0.0", { safe_to_drop: 0.99 }), score("m1", { requires_exact_preservation: 0.98 })]);
  assert.equal(traces[0].action, "KEEP_EXACT");
});
test("backend sees full actual tool result, rejects malformed results", async () => {
  const body: any[] = [];
  const provider = new JevCompatibleProvider({ endpoint: "http://localhost/v1/systemone", model: "custom", maxRequestTokens: 10000, timeoutMs: 1000 }, async (_url, options) => {
    body.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ answers: Object.fromEntries(predicates.map(p => [p, { noul: 0.5 }])) }), { status: 200 });
  });
  const content = "actual result ".repeat(800);
  await provider.evaluate({ task, chunks: [{ id: "result", kind: "tool_result", content }] });
  assert.equal(body[0].state.candidate.content, content);
  assert.equal(body[0].model, "custom");
  await assert.rejects(() => provider.evaluate({ task, chunks: [{ id: "result", kind: "tool_result", content: "x".repeat(50000) }] }), /exceeds/);
  assert.throws(() => decide([chunk("x", "x")], [score("x", { safe_to_drop: NaN })]), /Invalid/);
});
