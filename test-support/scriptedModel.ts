// A chat model for tests: each turn is scripted, optionally as a function of the conversation so far.
// It records every input, so tests can check what the model was shown (F12).
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

export type Step = AIMessage | ((messages: BaseMessage[]) => AIMessage);

export class ScriptedModel extends BaseChatModel {
  readonly script: Step[];
  readonly seen: BaseMessage[][] = [];

  constructor(script: Step[]) {
    super({});
    this.script = script;
  }

  _llmType(): string { return "scripted"; }

  override bindTools(): this { return this; }

  async _generate(messages: BaseMessage[]) {
    this.seen.push(messages);
    const step = this.script.shift() ?? new AIMessage("(script finished)");
    const message = typeof step === "function" ? step(messages) : step;
    return { generations: [{ message, text: typeof message.content === "string" ? message.content : "" }] };
  }
}

let n = 0;
/** An AI message that calls poppy_call. */
export const call = (company: string, method: string, path: string, body?: object) =>
  new AIMessage({ content: "", tool_calls: [{ id: `call_${++n}`, name: "poppy_call",
    args: { company, method, path, ...(body ? { body } : {}) } }] });

export const say = (text: string) => new AIMessage(text);

/** The JSON body of the most recent tool result. */
export const lastToolResult = (messages: BaseMessage[]): { status?: number; body?: unknown; error?: string } =>
  JSON.parse(String(messages.filter((m) => m.getType() === "tool").at(-1)?.content ?? "{}"));
