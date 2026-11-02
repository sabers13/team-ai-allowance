/**
 * The complete route table, in one place.
 *
 * Adding a route means adding a line with an explicit auth level; there is no
 * way to register a handler without deciding who may call it.
 */

import type { ApiDependencies } from "../deps.ts";
import { Router } from "../router.ts";
import { registerAdminRoutes } from "./admin.ts";
import { registerAuthRoutes } from "./auth.ts";
import { registerManagerRoutes } from "./manager.ts";
import { registerMemberRoutes } from "./member.ts";

export function buildRouter(deps: ApiDependencies): Router {
  const router = new Router();
  registerAuthRoutes(router, deps);
  registerMemberRoutes(router, deps);
  registerManagerRoutes(router, deps);
  registerAdminRoutes(router, deps);
  return router;
}
