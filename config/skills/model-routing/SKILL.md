---
name: model-routing
description: Choose the right model for a task or workflow stage using live benchmark data. Use when delegating work to subagents, authoring or running inline workflows, or whenever deciding which model should handle a task.
---

# Model routing

Do not guess model quality and do not rely on fixed `small`/`medium`/`big`
profiles. Those profiles have been removed from this machine. Pick a model per
task from live data.

## 1. Read the catalogue first

Call the `list_models` tool before delegating work:

```
list_models(sort_by: "coding", limit: 15)
list_models(sort_by: "cost_efficiency", provider: "openai-codex")
list_models(query: "opus", detail: "full")
```

It returns, per model:

- Artificial Analysis Intelligence, Coding and Math indices
- Terminal-Bench Hard, Terminal-Bench 2.1, τ²-bench, τ-bench Banking
- LiveCodeBench, SciCode, GPQA Diamond, HLE, MMLU-Pro, IFBench, AIME, MATH-500,
  long-context reasoning
- price per 1M input/output/blended tokens, throughput, time to first token
- cost-efficiency ratios (score per dollar)
- `billing` (`sub` or `paid`) and remaining subscription quota
- `conf`: `measured`, `inferred`, or `unrated`

## 2. Match the metric to the task

| Task | Rank by |
|---|---|
| Agentic coding, terminal work, multi-step edits | Terminal-Bench Hard, then Coding Index |
| Tool-calling reliability | τ²-bench |
| Algorithmic code generation | LiveCodeBench, SciCode |
| Research, analysis, hard reasoning | GPQA, HLE, Intelligence Index |
| Long document or repo-wide reasoning | long-context reasoning, context window |
| Bulk or throwaway fan-out | cost efficiency and tok/s |

## 3. Respect billing policy

- Subscription models (`anthropic/*`, `openai-codex/*`) are free to use. Prefer
  them, and prefer accounts with quota remaining.
- Metered models (`openrouter/*`, `google/*`, `openai/*`, `xai/*`) are blocked at
  the provider boundary until the user runs `/model-approve <provider>`. If a
  call is blocked, switch to a subscription model or ask the user; never retry
  in a loop.
- Check `/model-policy` for the current spend ceiling.

## 4. Use explicit models in workflows

In inline workflow scripts pass `model` on each `agent()` call:

```ts
const findings = await parallel([
  () => agent(prompt, { model: "openai-codex/gpt-5.6-terra", schema: Finding }),
  () => agent(prompt, { model: "anthropic/claude-sonnet-5", schema: Finding }),
]);

const synthesis = await agent(summaryPrompt, {
  model: "anthropic/claude-opus-5",
  thinkingLevel: "high",
});
```

Rules:

- Always use the full `provider/id` form.
- Give cheap, fast, high-throughput models the wide fan-out stages.
- Give the strongest agentic model the synthesis, planning and patch-writing
  stages.
- Thinking level changes measured quality: `list_models` scores resolve per
  effort level where Artificial Analysis publishes them, so raise
  `thinkingLevel` when a stage is hard rather than switching to a costlier model
  by default.
- If a model is `unrated`, say so before using it for important work, and prefer
  a `measured` alternative of similar cost.

## 5. Quota awareness

If Claude's 5h pool is nearly exhausted, route to Codex instead of stalling, and
mention the switch. The `/usage` bar shows remaining quota for every account.
