/**
 * The single place Web builds its backend clients. Every network call in
 * apps/web goes through @wpt/api-client from here. No screen calls fetch()
 * or socket.io directly.
 *
 * API_BASE_URL (next.config.mjs → .env.local) is the only thing that decides
 * whether this is the WEB-R1.0 mock or the real backend (BE-6.1).
 */

import { createWebSessionApi } from "@wpt/api-client";

export const API_BASE_URL: string = process.env.API_BASE_URL ?? "http://localhost:4010";

export const sessionApi = createWebSessionApi({ baseUrl: API_BASE_URL });
