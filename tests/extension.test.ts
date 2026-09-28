import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../src/extension.js";
import { predicates } from "../src/core.js";

test("Pi hook returns summary, preserves raw tail boundary, stores trace outside context; backend failure falls through", async () => {
  let handler: any, summarized = 0; const notices: string[] = []; 
  extension({ on: (_event: string, h: any) => { handler = h; } } as any);
  const original = globalThis.fetch;
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-only";
  const context: any = {
    cwd: process.cwd(), model: { id: "chosen-model" }, ui: { notify: (message: string) => notices.push(message) },
    modelRegistry: { complete: async () => {
      summarized++;
      return { stopReason: "stop", content: [{ type: "text", text: "Auth is unfinished; preserve auth failure." }], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    } },
  };
  const event: any = { signal: new AbortController().signal, branchEntries: [], preparation: {
    messagesToSummarize: [{ role: "user", content: "Implement auth", timestamp: Date.now() }], turnPrefixMessages: [],
    tokensBefore: 40, firstKeptEntryId: "raw-tail-start", previousSummary: undefined,
  } };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ answers: Object.fromEntries(predicates.map(p => [p, { noul: p === "useful_but_summarizable" ? 0.9 : 0.1 }])) }), { status: 200 });
    const value = await handler(event, context);
    assert.ok(value, notices.join("; "));
    assert.equal(value.compaction.firstKeptEntryId, "raw-tail-start");
    assert.match(value.compaction.summary, /Auth is unfinished/);
    assert.equal(value.compaction.details.chunks[0].action, "SUMMARIZE");
    assert.equal(summarized, 1);
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    assert.equal(await handler(event, context), undefined);
  } finally { globalThis.fetch = original; if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; }
});
