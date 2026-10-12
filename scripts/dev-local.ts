// Boots Tipping Co (:8787) and the agent host (:8788) in one process, with the dev localhost flag.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startAgentHost } from "agent-host/server";
import { startCompany } from "company/server";
import { generateAgentKeys, keysDir } from "./keys.ts";

process.env.POPPY_DEV_ALLOW_HTTP_LOCALHOST = "1";
if (process.env.POPPY_LOG_FILE) {
  mkdirSync(dirname(process.env.POPPY_LOG_FILE), { recursive: true });
  writeFileSync(process.env.POPPY_LOG_FILE, "");
}
const { publicJwk, created } = await generateAgentKeys(keysDir());
if (created) console.log(`[dev-local] generated agent signing key kid=${publicJwk.kid}`);
startCompany({ port: 8787 });
startAgentHost({ port: 8788, publicJwk });
// A second, hostile agent for the attack suite (npm run attacks).
const attacker = await generateAgentKeys(keysDir(), false, "attacker");
startAgentHost({ port: 8789, publicJwk: attacker.publicJwk, clientName: "Mallory's Agent" });
