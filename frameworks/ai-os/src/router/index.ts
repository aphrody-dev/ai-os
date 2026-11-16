// Router: model catalog, policy, failover engine, arena, and its relay surfaces (http.ts, tools.ts).
import { Router } from "./engine.ts";

let shared: Router | undefined;
/** Process-wide router over the sqlite store in relayHome(). */
export const router = () => (shared ??= new Router());

export * from "./catalog.ts";
export * from "./engine.ts";
export * from "./policy.ts";
export * from "./stats.ts";
