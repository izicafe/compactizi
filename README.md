# Pi decision compaction (working name)

Session-only replacement for Pi compaction: a Jev-compatible decision model evaluates **actual chunk contents** against the current task; deterministic policy selects `KEEP_EXACT`, `SUMMARIZE`, or `DROP`. Only selected chunks go to the currently selected Pi GPT/Claude model for summarization. No second generative-model key, project memory, or vector store.

## Install

Requires Node >= 22.19 and `@earendil-works/pi-coding-agent` 0.87.1+ (tested with 0.87.1). From a checkout:

```sh
npm install --ignore-scripts
pi -e ./src/extension.ts
# or: pi install ./path/to/checkout
```

Set Pi's own compaction settings to control the **raw recent tail** (Pi chooses the cut before the extension runs):

```json
{ "compaction": { "enabled": true, "keepRecentTokens": 16000, "reserveTokens": 16384 } }
```

Put this in `~/.pi/agent/settings.json` or the trusted project's `.pi/settings.json`. `/compact` and automatic/overflow compaction use the hook; the original append-only JSONL trajectory is unchanged. Do not load multiple competing compaction extensions.

Copy `examples/decision-compaction.json` to `<project>/.pi/decision-compaction.json` or set `PI_DECISION_COMPACTION_CONFIG` to an absolute config-file path. The config file itself is not required (defaults target hosted Jev). Set `TYPESAFE_API_KEY` in the environment before starting Pi; do not commit credentials.

For a compatible OpenJev or self-hosted/fine-tuned System One endpoint, replace `provider.endpoint` and `provider.model`; set `provider.apiKeyEnv` to your environment variable name, or omit it/set it to `null` for an unauthenticated local endpoint. Example:

```json
{ "provider": { "endpoint": "http://127.0.0.1:8080/v1/systemone", "model": "my-openjev-v2", "apiKeyEnv": null } }
```

Only the System One `state`/`questions`/`answers.*.noul` wire protocol is implemented. Other decision models implement `CompactionDecisionProvider.evaluate({ task, chunks, signal })` from `src/core.ts` and supply an adapter to the hook; core policy does not depend on Jev SDKs. A backend must return exactly one result per chunk and all six probabilities in `[0,1]`. The shipped adapter sends **each candidate in full**, plus a short neighboring context; oversized candidates fail safely to native Pi instead of being judged from an omitted placeholder. Hosted endpoints receive the session's selected old text and tool outputs: choose a trusted endpoint.

## How it works

Pi's `session_before_compact` preparation supplies the old prefix, optional previous summary, raw-tail boundary, and token estimate. User, assistant text, tool call, tool result, and other message content become chunks with per-pass stable IDs; tool call/result IDs are linked. The latest user request on the branch supplies the active task. Six independent `noul` questions cover task relevance, persistent constraint, unresolved work, exact fidelity, summarizability, and safe deletion. Thresholds (`keepExact`, `retain`, `drop`, `conflicting`) are configurable. Exact fidelity/constraints win, relevant work is summarized, only high-confidence safe-to-drop with no conflicting evidence is dropped; uncertainty is summarized. Kept tool results retain their associated calls.

The Pi-selected model is called through `ctx.modelRegistry.complete()` (Pi resolves its configured provider credentials). It sees **only SUMMARIZE chunks**, one at a time, splitting huge chunks into bounded segments. If over the estimated `targetTokens` budget, summaries are compressed again; exact chunks and Pi's raw tail are never automatically deleted. If that is insufficient, or the backend/model/config fails, the handler returns nothing and Pi uses **native compaction**. In particular native fallback is not a guarantee of verbatim constraints; review the native summary after failure. Images in the old prefix also use native compaction because a string summary cannot reproduce them. Token counts use Pi's estimate/characters-per-four and are approximate, not a hard context-window guarantee. Pick `targetTokens` larger than Pi's `keepRecentTokens` with room for critical exact text; keep Pi's reserve setting appropriate for the active model.

The resulting summary is readable Markdown in Pi's standard compaction entry. The entry `details` contains `originalTokens`, `finalTokensEstimated`, estimated tail and summary tokens, action counts, per-chunk probabilities/action/reason; details are **not** inserted into model context. Inspect the compaction entry in Pi's session JSONL to debug decisions. Details have no raw candidate content or credentials.

## Tests and offline comparison

```sh
npm run check
npm test
npm run eval -- fixtures/example.json
```

The fixture records a native-style summary and decision outputs for the **same** messages, plus the raw tail. The evaluation command prints both contexts, estimated counts, and actions; it makes no API calls and does **not** claim to generate a new native Pi summary. For a real comparison, save an actual native Pi summary and backend outputs in a fixture of the same shape. Unit tests inject a decision transport; they need no keys. A live end-to-end request needs your configured Pi model and decision endpoint; it is not exercised by the offline suite.

Reference inspected: `tamaratran/fast-jev-compaction` and `joelhooks/pi-fast-jev-compaction` (MIT). This implementation is independent; unlike their state fitting it does not hide the content of a tool result from the decision made about that result.

License: MIT.
