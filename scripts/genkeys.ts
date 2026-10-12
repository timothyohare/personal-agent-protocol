// Generates the agent's ES256 signing key pair (briefing 9.4). Usage: npm run genkeys [-- --force]
import { generateAgentKeys, keysDir } from "./keys.ts";

const { publicJwk, created } = await generateAgentKeys(keysDir(), process.argv.includes("--force"));
console.log(created ? `generated agent signing key kid=${publicJwk.kid} in ${keysDir()}`
  : `agent signing key already exists (kid=${publicJwk.kid}); use --force to replace it`);
