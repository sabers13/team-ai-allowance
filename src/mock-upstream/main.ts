/**
 * Container entry point for the mock upstream.
 *
 * The compose stack runs this file with Node's built-in TypeScript support:
 * `node src/mock-upstream/main.ts`. Only PORT and HOST are read.
 */
import { startMockUpstream } from "./server.ts";

const port = Number.parseInt(process.env.PORT ?? "4001", 10);
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  process.stderr.write("mock upstream: PORT must be a TCP port number\n");
  process.exit(2);
}

const upstream = await startMockUpstream({ host, port });
process.stdout.write(`mock upstream listening on ${upstream.url}\n`);

const shutdown = (): void => {
  upstream
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
