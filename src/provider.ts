import { type CompactionDecisionProvider, type DecisionInput, type DecisionResult, predicates, tokens } from "./core.js";

export type ProviderConfig = { endpoint: string; model: string; apiKeyEnv?: string; maxRequestTokens: number; timeoutMs: number };
/** Compatible System One `noul` adapter. Endpoint/model are configuration, never part of core policy. */
export class JevCompatibleProvider implements CompactionDecisionProvider {
  constructor(private config: ProviderConfig, private transport: typeof fetch = fetch) {}
  async evaluate({ task, chunks, signal }: DecisionInput): Promise<DecisionResult[]> {
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (this.config.apiKeyEnv && !key) throw new Error("Decision provider credentials unavailable");
    const output: DecisionResult[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Candidate content is NEVER truncated. Overlarge requests fail back to native Pi compaction.
      const state = { activeTask: task, candidate: chunk, neighborhood: [chunks[i - 1], chunks[i + 1]].filter(Boolean).map(c => ({ id: c.id, kind: c.kind, content: c.content.slice(0, 600) })) };
      const questions = Object.fromEntries(predicates.map(p => [p, {
        type: "noul", instructions: `${p.replaceAll("_", " ")}? Judge the ACTUAL candidate content relative to the active task. Answer yes only if evidence supports it.`,
        criteria: { true: `The candidate ${p.replaceAll("_", " ")}.`, false: `The candidate does not ${p.replaceAll("_", " ")}.` },
      }]));
      const body = JSON.stringify({ model: this.config.model, state, questions });
      if (tokens(body) > this.config.maxRequestTokens) throw new Error("Candidate exceeds decision request budget");
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      const response = await this.transport(this.config.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`Decision provider HTTP ${response.status}`);
      const data = await response.json() as { answers?: Record<string, { noul?: number }> };
      const probabilities = Object.fromEntries(predicates.map(p => [p, data.answers?.[p]?.noul]));
      output.push({ id: chunk.id, probabilities } as DecisionResult);
    }
    return output;
  }
}
