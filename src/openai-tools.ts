/**
 * OpenAI function-calling schemas + dispatcher.
 *
 * The same operations as `agent-tools.ts`, but in OpenAI's
 * Chat Completions function-calling shape so callers using the OpenAI SDK
 * (or any compatible runtime: Ollama, vLLM, LiteLLM, etc.) can drive Arc
 * with the exact same toolkit.
 *
 * Key shape differences vs Anthropic:
 *   - Tool wrapper: `{ type: "function", function: { name, description, parameters } }`
 *   - `parameters` (not `input_schema`)
 *   - Model returns `tool_calls: [{ id, type: "function", function: { name, arguments } }]`
 *     where `arguments` is a JSON-encoded string (Anthropic returns parsed objects).
 *
 * Names + descriptions are kept verbatim with the Anthropic schemas so
 * prompts and behavior stay portable across providers.
 */

import { arcAgentTools, dispatchTool, type DispatchDeps } from "./agent-tools.js";

/**
 * OpenAI Chat Completions tool wrapper.
 * Compatible with `openai` SDK v4+ and any drop-in (LiteLLM, vLLM, Ollama).
 */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: readonly string[];
    };
  };
}

/** Minimal shape of an OpenAI `tool_call` returned by the model. */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments — OpenAI passes a string here, not a parsed object. */
    arguments: string;
  };
}

/** Minimal shape of a `tool` message you'd feed back into the next turn. */
export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/**
 * Same operations as `arcAgentTools`, exposed in OpenAI's tool-call shape.
 * Drop this directly into `openai.chat.completions.create({ tools, ... })`.
 */
export const arcAgentToolsOpenAI: readonly OpenAITool[] = arcAgentTools.map(
  (t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: t.input_schema.properties,
        required: t.input_schema.required,
      },
    },
  }),
);

/**
 * Execute a single OpenAI tool_call against the Arc backend. Returns an
 * OpenAI-shape `tool` message ready to append to the next request.
 *
 * Handles the two OpenAI-specific quirks vs Anthropic:
 *   1. `tool_call.function.arguments` is a JSON string — we parse it.
 *   2. The result is wrapped as a `role: "tool"` message with `tool_call_id`.
 */
export async function dispatchOpenAIToolCall(
  toolCall: OpenAIToolCall,
  deps: DispatchDeps,
): Promise<OpenAIToolMessage> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(toolCall.function.arguments);
  } catch {
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        error: "could not parse tool_call.function.arguments as JSON",
        raw: toolCall.function.arguments,
      }),
    };
  }
  const content = await dispatchTool(toolCall.function.name, input, deps);
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content,
  };
}

/**
 * Convenience: execute every tool_call in an assistant message in parallel
 * and return an array of `tool` messages to append before the next turn.
 */
export async function dispatchOpenAIToolCalls(
  toolCalls: readonly OpenAIToolCall[],
  deps: DispatchDeps,
): Promise<OpenAIToolMessage[]> {
  return Promise.all(toolCalls.map((tc) => dispatchOpenAIToolCall(tc, deps)));
}

// Re-export for convenience so callers can grab everything from one path.
export type { DispatchDeps } from "./agent-tools.js";
