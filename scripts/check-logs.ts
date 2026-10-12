// A-22 / N5: scans $POPPY_LOG_FILE (written by both services and the acceptance run) for anything
// shaped like a secret: JWTs, and bare 43-character base64url values (tokens, codes, verifiers, keys).
import { readFileSync } from "node:fs";

const file = process.env.POPPY_LOG_FILE;
if (!file) {
  console.log("check-logs: POPPY_LOG_FILE not set, nothing to scan");
  process.exit(0);
}
const text = readFileSync(file, "utf8");
const patterns: [string, RegExp][] = [
  ["JWT", /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g],
  ["43-char base64url value", /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
];
let bad = 0;
for (const [name, re] of patterns) {
  for (const m of text.matchAll(re)) {
    bad++;
    console.log(`check-logs: ${name} at offset ${m.index}`);
  }
}
const lines = text.split("\n").filter(Boolean).length;
console.log(bad ? `check-logs: ✗ ${bad} secret-shaped value(s) in ${lines} lines` : `check-logs: ✓ ${lines} lines, no secrets`);
process.exit(bad ? 1 : 0);
