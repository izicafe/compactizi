import { readFile } from "node:fs/promises";
import { chunkMessages, decide, extractTask, render, tokens, type DecisionResult } from "../src/core.js";

// Offline comparison of *recorded* native-Pi and decision outputs for the same session prefix.
// No model calls: fixture must include recorded native summary and decisions/summaries.
const file = process.argv[2] ?? "fixtures/example.json";
type Fixture = {
  messages: { role: string; content: unknown }[]; tail?: { role: string; content: unknown }[];
  nativeSummary: string; decisions: DecisionResult[]; summaries: Record<string, string>;
};
let fixture: Fixture;
try { fixture = JSON.parse(await readFile(file, "utf8")) as Fixture; }
catch (error) { console.error(`Cannot read fixture ${file}:`, error); process.exit(1); }
const chunks = chunkMessages(fixture.messages as any);
const traces = decide(chunks, fixture.decisions);
const state = render(chunks, traces, new Map(Object.entries(fixture.summaries)), extractTask([...fixture.messages, ...fixture.tail ?? []]));
const tail = JSON.stringify(fixture.tail ?? []);
console.log(JSON.stringify({ native: { estimatedTokens: tokens(fixture.nativeSummary + tail), context: fixture.nativeSummary }, decision: { estimatedTokens: tokens(state + tail), actions: traces, context: state }, recentRawTail: fixture.tail ?? [] }, null, 2));
