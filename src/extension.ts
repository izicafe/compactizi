import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkMessages, decide, defaultThresholds, extractTask, render, tokens, type CompactChunk, type Trace, type Thresholds } from "./core.js";
import { JevCompatibleProvider, type ProviderConfig } from "./provider.js";

type Config = { provider: ProviderConfig; thresholds: Thresholds; targetTokens: number; summaryInputTokens: number; summaryOutputTokens: number };
const defaults: Config = {
  provider: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY", maxRequestTokens: 30000, timeoutMs: 30000 },
  thresholds: defaultThresholds, targetTokens: 30000, summaryInputTokens: 6000, summaryOutputTokens: 900,
};
async function config(cwd: string): Promise<Config> {
  let parsed: any = {};
  const path = process.env.PI_DECISION_COMPACTION_CONFIG ?? join(cwd, ".pi", "decision-compaction.json");
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch (e: any) { if (e.code !== "ENOENT") throw e; }
  const result = { ...defaults, ...parsed, provider: { ...defaults.provider, ...parsed.provider }, thresholds: { ...defaults.thresholds, ...parsed.thresholds } };
  if (!/^https?:\/\//.test(result.provider.endpoint) || !result.provider.model ||
    [result.targetTokens, result.summaryInputTokens, result.summaryOutputTokens, result.provider.maxRequestTokens, result.provider.timeoutMs].some(n => !Number.isSafeInteger(n) || n < 1) ||
    Object.values(result.thresholds).some(n => typeof n !== "number" || n < 0 || n > 1)) throw new Error("Invalid decision compaction config");
  return result;
}
const extract = (response: { content: { type: string; text?: string }[]; stopReason: string }) => {
  if (response.stopReason !== "stop") throw new Error(`Summarization stopped: ${response.stopReason}`);
  const value = response.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
  if (!value) throw new Error("Empty summary");
  return value;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const cfg = await config(ctx.cwd);
      const selectedModel = ctx.model;
      if (!selectedModel) throw new Error("No selected Pi model");
      const model = selectedModel;
      const prep = event.preparation;
      const messages = [...prep.messagesToSummarize, ...prep.turnPrefixMessages];
      // Images cannot be reconstituted verbatim into Pi's string summary.
      if (messages.some(m => JSON.stringify(m).includes('"type":"image"'))) throw new Error("Image in old context");
      const task = extractTask([...messages, ...event.branchEntries.filter(e => e.type === "message").map(e => e.message)] as any);
      const chunks: CompactChunk[] = chunkMessages(messages as any);
      if (prep.previousSummary) chunks.unshift({ id: "previous-summary", kind: "other", content: prep.previousSummary });
      if (!chunks.length) return; // Pi can handle degenerate cases.
      const results = await new JevCompatibleProvider(cfg.provider).evaluate({ task, chunks, signal: event.signal });
      const traces = decide(chunks, results, cfg.thresholds);
      // A previous summary already lost its underlying source; never drop it solely on a new classification.
      if (prep.previousSummary && traces[0].action === "DROP") { traces[0].action = "SUMMARIZE"; traces[0].reason = "previous checkpoint cannot be recovered"; }
      const summaries = new Map<string, string>();
      const usage: any[] = [];
      async function summarize(chunk: CompactChunk, budget: number) {
        const maxChars = cfg.summaryInputTokens * 4;
        const parts = chunk.content.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, "g")) ?? [""];
        const output: string[] = [];
        for (const part of parts) {
          const prompt = `Summarize ONLY this selected session chunk for continuation. Preserve needed exact identifiers, paths, commands, failing assertions and uncertainty. Never invent facts or upgrade uncertainty. Active task: ${task.task}\nChunk ${chunk.id} (${chunk.kind}):\n${part}`;
          const response = await ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { maxTokens: budget, signal: event.signal, cacheRetention: "none" });
          output.push(extract(response)); usage.push(response.usage);
        }
        return output.join("\n");
      }
      for (let i = 0; i < chunks.length; i++) if (traces[i].action === "SUMMARIZE") summaries.set(chunks[i].id, await summarize(chunks[i], cfg.summaryOutputTokens));
      let summary = render(chunks, traces, summaries, task);
      // Pi controls the recent raw tail; do not silently lose exact retained content to meet budget.
      const oldEstimate = messages.reduce((sum, m) => sum + estimateTokens(m), 0) + (prep.previousSummary ? tokens(prep.previousSummary) : 0);
      const tailEstimate = Math.max(0, prep.tokensBefore - oldEstimate);
      const available = cfg.targetTokens - tailEstimate;
      if (tokens(summary) > available) {
        for (let i = 0; i < chunks.length && tokens(summary) > available; i++) {
          const c = chunks[i];
          if (traces[i].action !== "SUMMARIZE") continue;
          summaries.set(c.id, await summarize({ ...c, content: summaries.get(c.id)! }, Math.max(100, Math.floor(cfg.summaryOutputTokens / 3))));
          summary = render(chunks, traces, summaries, task);
        }
      }
      if (tokens(summary) > available) throw new Error("Exact retention + raw tail exceed target budget");
      const totalUsage = usage.reduce((a, u) => {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) a[key] += u?.[key] ?? 0;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) a.cost[key] += u?.cost?.[key] ?? 0;
        return a;
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
      const report = { originalTokens: prep.tokensBefore, finalTokensEstimated: tokens(summary) + tailEstimate, summaryTokensEstimated: tokens(summary), tailTokensEstimated: tailEstimate, actions: { KEEP_EXACT: traces.filter(t => t.action === "KEEP_EXACT").length, SUMMARIZE: traces.filter(t => t.action === "SUMMARIZE").length, DROP: traces.filter(t => t.action === "DROP").length }, chunks: traces };
      // details stay out of the model-facing context, in Pi's append-only compaction entry.
      ctx.ui.notify(`Decision compaction: ${report.finalTokensEstimated} estimated tokens; ${report.actions.KEEP_EXACT}/${report.actions.SUMMARIZE}/${report.actions.DROP} exact/summary/drop`, "info");
      return { compaction: { summary, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, estimatedTokensAfter: report.finalTokensEstimated, usage: totalUsage, details: report } };
    } catch (error) {
      if (!event.signal.aborted) ctx.ui.notify(`Decision compaction fallback to native Pi: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
      return; // Native Pi handles the original preparation and canonical session remains intact.
    }
  });
}
