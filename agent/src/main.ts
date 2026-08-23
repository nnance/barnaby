/**
 * Entry point. Loads config, binds, and handles shutdown.
 *
 * Kept separate from server.ts so the routes can be tested against an
 * ephemeral port without a process starting itself on import.
 */

import { load } from "./config.ts";
import * as log from "./log.ts";
import { createAgentServer } from "./server.ts";

const cfg = load();
const server = createAgentServer(cfg);

server.listen(cfg.port, cfg.host, () => {
	log.info(`agent server on ${cfg.host}:${cfg.port} -> ${cfg.upstream}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		log.info(`${signal}, shutting down`);
		server.close(() => process.exit(0));
		// Do not wait forever on in-flight streams.
		setTimeout(() => process.exit(0), 2_000).unref();
	});
}
