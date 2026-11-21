import type { AppConfig, LLMMessage, SceneKind, ToolCall } from "./types.js";
import type { Paths } from "./config.js";
import type { ToolContext } from "./tools.js";
import { callLLM } from "./llm.js";
import { isPeak } from "./pricing.js";
import { runTool, toolSchemas } from "./tools.js";
import { recordUsage } from "./usage.js";

export interface LoopOptions {
  config: AppConfig;
  paths: Paths;
  messages: LLMMessage[];
  scene: SceneKind;
  maxSteps: number;
  maxTokens: number;
  toolContext: ToolContext;
  kind: string;
  signal?: AbortSignal;
  llmOptions?: { attempts?: number; timeoutMs?: number };
}

export interface LoopResult {
  content: string;
  toolCalls: { name: string; args: unknown }[];
}

export async function runToolLoop(options: LoopOptions): Promise<LoopResult> {
  const { config, paths, messages, scene, maxSteps, maxTokens, toolContext, kind, signal, llmOptions } = options;
  const tools = toolSchemas(scene);
  const called: { name: string; args: unknown }[] = [];
  let content = "";

  for (let step = 0; step < Math.max(1, maxSteps); step++) {
    const result = await callLLM(config, messages, {
      maxTokens,
      tools,
      toolChoice: "auto",
      signal,
      attempts: llmOptions?.attempts,
      timeoutMs: llmOptions?.timeoutMs,
    });
    content = result.content;
    const peak = isPeak(config, Date.now());
    recordUsage(paths, config, {
      model: result.model,
      provider: config.model.provider,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      cacheHitTokens: result.usage.prompt_cache_hit_tokens,
      cacheMissTokens: result.usage.prompt_cache_miss_tokens,
      peak,
      kind,
    });

    if (!result.toolCalls.length) {
      return { content, toolCalls: called };
    }

    messages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      const name = call.function?.name ?? "";
      let args: unknown = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = { raw: call.function?.arguments };
      }
      called.push({ name, args });
      const output = await runTool(toolContext, name, call.function?.arguments ?? "{}");
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: clipToolResult(output),
      });
    }
  }

  return { content, toolCalls: called };
}

function clipToolResult(text: string): string {
  const max = 4000;
  if (text.length <= max) return text;
  return `${text.slice(0, 2800)}\n…（中间省略）…\n${text.slice(-800)}`;
}

export function collectToolNames(toolCalls: ToolCall[]): string[] {
  return toolCalls.map((call) => call.function?.name).filter(Boolean);
}
