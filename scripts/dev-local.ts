// Local boot stub until Task 6: serve a readiness endpoint on the company port.
import { createServer } from "node:http";
createServer((_req, res) => res.end("ok")).listen(8787, () => console.log("dev-local stub on :8787"));
