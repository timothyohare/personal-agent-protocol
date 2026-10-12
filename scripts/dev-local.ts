// Boots Tipping Co (:8787) and the agent host (:8788) in one process, with the dev localhost flag.
import { startAgentHost } from "agent-host/server";
import { startCompany } from "company/server";
import { generateAgentKeys, keysDir } from "./keys.ts";

process.env.POPPY_DEV_ALLOW_HTTP_LOCALHOST = "1";
const { publicJwk, created } = await generateAgentKeys(keysDir());
if (created) console.log(`[dev-local] generated agent signing key kid=${publicJwk.kid}`);
startCompany({ port: 8787 });
startAgentHost({ port: 8788, publicJwk });
