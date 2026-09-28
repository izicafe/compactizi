export const predicates = ["relevant_to_active_task", "contains_persistent_constraint", "contains_unresolved_work", "requires_exact_preservation", "useful_but_summarizable", "safe_to_drop"] as const;
export type Predicate = typeof predicates[number];
export type Action = "KEEP_EXACT" | "SUMMARIZE" | "DROP";
export type CompactChunk = { id: string; kind: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "other"; content: string; timestamp?: string; toolName?: string; toolInput?: unknown; relatedChunkIds?: string[] };
export type ActiveTaskState = { task: string; immediateGoal?: string; constraints?: string[] };
export type DecisionResult = { id: string; probabilities: Record<Predicate, number> };
export type DecisionInput = { task: ActiveTaskState; chunks: CompactChunk[]; signal?: AbortSignal };
export interface CompactionDecisionProvider { evaluate(input: DecisionInput): Promise<DecisionResult[]> }
export type Thresholds = { keepExact: number; retain: number; drop: number; conflicting: number };
export const defaultThresholds: Thresholds = { keepExact: 0.8, retain: 0.7, drop: 0.95, conflicting: 0.35 };
export type Trace = { id: string; kind: CompactChunk["kind"]; action: Action; probabilities: Record<Predicate, number>; reason: string };
export const tokens = (text: string) => Math.ceil(text.length / 4);

export function decide(chunks: CompactChunk[], results: DecisionResult[], thresholds: Thresholds = defaultThresholds): Trace[] {
  const byId = new Map(results.map(r => [r.id, r]));
  if (byId.size !== chunks.length || results.length !== chunks.length) throw new Error("Incomplete decision response");
  const traces = chunks.map(chunk => {
    const p = byId.get(chunk.id)?.probabilities;
    if (!p || predicates.some(k => typeof p[k] !== "number" || !Number.isFinite(p[k]) || p[k] < 0 || p[k] > 1)) throw new Error(`Invalid decisions: ${chunk.id}`);
    let action: Action = "SUMMARIZE", reason = "uncertain: conservative retention";
    if (Math.max(p.requires_exact_preservation, p.contains_persistent_constraint) >= thresholds.keepExact) {
      action = "KEEP_EXACT"; reason = "fidelity or persistent constraint";
    } else if (Math.max(p.relevant_to_active_task, p.contains_unresolved_work, p.useful_but_summarizable) >= thresholds.retain) {
      reason = "relevant or useful";
    } else if (p.safe_to_drop >= thresholds.drop && Math.max(p.relevant_to_active_task, p.contains_unresolved_work, p.requires_exact_preservation, p.contains_persistent_constraint) < thresholds.conflicting) {
      action = "DROP"; reason = "high-confidence safe to drop";
    }
    return { id: chunk.id, kind: chunk.kind, action, probabilities: p, reason };
  });
  // Tool result without its call loses provenance; an exact call also retains its result unless explicitly safe to drop.
  const positions = new Map(chunks.map((c, i) => [c.id, i]));
  for (let i = 0; i < chunks.length; i++) {
    if (traces[i].action === "DROP") continue;
    for (const id of chunks[i].relatedChunkIds ?? []) {
      const j = positions.get(id);
      if (j === undefined || traces[j].action !== "DROP") continue;
      if (chunks[i].kind === "tool_result" && chunks[j].kind === "tool_call") {
        traces[j].action = "KEEP_EXACT"; traces[j].reason = "paired with retained tool result";
      }
    }
  }
  return traces;
}

export function render(chunks: CompactChunk[], traces: Trace[], summaries: Map<string, string>, task: ActiveTaskState): string {
  const lines = ["[COMPACTED SESSION STATE]", `Active task: ${task.task}`, "", "## Preserved context and compressed prior work"];
  for (let i = 0; i < chunks.length; i++) {
    const { action } = traces[i];
    if (action === "DROP") continue;
    const c = chunks[i];
    lines.push(`\n### ${c.id} (${c.kind}${c.toolName ? `: ${c.toolName}` : ""}; ${action})`, action === "KEEP_EXACT" ? c.content : summaries.get(c.id) ?? "");
  }
  return lines.join("\n");
}

export function extractTask(messages: { role: string; content?: unknown }[]): ActiveTaskState {
  const users = messages.filter(m => m.role === "user").map(m => text(m.content)).filter(Boolean);
  return { task: users.at(-1)?.slice(0, 4000) || "Continue the current session", immediateGoal: users.slice(-2).join("\n").slice(0, 6000) };
}
export function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => c?.type === "text" ? c.text : c?.type === "image" ? "[image: unsupported in V0]" : "").join("\n");
  return "";
}

// One chunk per assistant content block; IDs are stable within the selected session prefix.
export function chunkMessages(messages: { role: string; content?: unknown; timestamp?: number; toolCallId?: string; toolName?: string; summary?: string; output?: string; command?: string }[]): CompactChunk[] {
  const chunks: CompactChunk[] = [], calls = new Map<string, string>();
  messages.forEach((m, i) => {
    const id = `m${i}`;
    const date = m.timestamp ? new Date(m.timestamp).toISOString() : undefined;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      m.content.forEach((block: any, j) => {
        const cid = `${id}.${j}`;
        if (block.type === "toolCall") {
          calls.set(block.id, cid);
          chunks.push({ id: cid, kind: "tool_call", content: JSON.stringify({ name: block.name, arguments: block.arguments }), toolName: block.name, toolInput: block.arguments, timestamp: date });
        } else if (block.type === "text" || block.type === "thinking") {
          chunks.push({ id: cid, kind: "assistant", content: block.type === "thinking" ? `[thinking] ${block.thinking}` : block.text, timestamp: date });
        }
      });
    } else {
      const kind = m.role === "toolResult" ? "tool_result" : m.role === "user" ? "user" : m.role === "system" ? "system" : "other";
      const related = m.toolCallId && calls.get(m.toolCallId);
      const content = m.role === "bashExecution" ? `${m.command}\n${m.output}` : m.summary ?? text(m.content);
      chunks.push({ id, kind, content, timestamp: date, toolName: m.toolName, relatedChunkIds: related ? [related] : undefined });
      if (related) chunks.find(c => c.id === related)!.relatedChunkIds = [id];
    }
  });
  return chunks;
}
