// npm run chat: talk to the personal agent (Claude via LangGraph) in the terminal (HowToVerify M6).
// Needs ANTHROPIC_API_KEY. Writes are confirmed here, in the terminal, never by the model.
// --dump-transcript prints every message at exit, to check that no secrets reached the model.
import { createInterface } from "node:readline/promises";
import { ChatAnthropic } from "@langchain/anthropic";
import { createLogger } from "poppy-core";
import { DEFAULT_MODEL, buildChatGraph, chatTurn } from "./chat.ts";
import { agentConfigFromEnv, agentFromConfig } from "./config.ts";
import { startLoopback } from "./loopback.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first (see docs/HUMAN-TODO.md).");
  process.exit(2);
}

const cfg = agentConfigFromEnv();
const agent = await agentFromConfig(cfg, createLogger("agent", console.error));
const rl = createInterface({ input: process.stdin, output: process.stdout });

/** Direct Sign-In: the user opens the URL and signs in themselves (spec 4.4). */
async function signIn(company: string, scopes: string[]): Promise<boolean> {
  const lb = await startLoopback();
  try {
    const c = agent.company(company);
    const url = await c.beginSignIn(scopes, { loopbackPort: lb.port });
    console.error(`\n${company} needs you to sign in. Open this URL in your browser:\n\n  ${url}\n`);
    await c.completeSignIn(await lb.result);
    console.error("Signed in.\n");
    return true;
  } catch (e) {
    console.error(`Sign-in didn't finish: ${(e as Error).message}`);
    return false;
  } finally {
    lb.close();
  }
}

const graph = buildChatGraph({
  model: new ChatAnthropic({ model: process.env.POPPY_MODEL ?? DEFAULT_MODEL, maxTokens: 1024 }),
  toolDeps: { agent, signIn },
  companies: [cfg.company],
});

const thread = `chat-${Date.now()}`;
console.log(`Personal agent ready (${process.env.POPPY_MODEL ?? DEFAULT_MODEL}). Ask about ${cfg.company}. Ctrl-D to quit.`);
try {
  for (;;) {
    const text = (await rl.question("> ")).trim();
    if (!text) continue;
    const answer = await chatTurn(graph, thread, text, async (r) =>
      /^y(es)?$/i.test((await rl.question(`${r.question} [y/N] `)).trim()));
    console.log(answer);
  }
} catch {
  // Ctrl-D closes readline.
} finally {
  rl.close();
  if (process.argv.includes("--dump-transcript")) {
    const state = await graph.getState({ configurable: { thread_id: thread } });
    console.log(JSON.stringify(state.values.messages, null, 2));
  }
}
