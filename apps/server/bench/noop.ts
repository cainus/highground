/**
 * A server that does nothing but read the request and answer, for the benchmark's
 * baseline: whatever latency it shows comes from the machine and Node's HTTP stack.
 */
import { createServer } from "node:http";

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"warnings":[]}');
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address === "object" && address) console.log(`http://127.0.0.1:${address.port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
