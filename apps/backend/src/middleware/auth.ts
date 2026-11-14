/**
 * JWT authentication middleware.
 *
 * Verifies the Bearer token from the Authorization header,
 * extracts userId/deviceId/sessionId from the validated JWT payload,
 * and attaches them to res.locals.auth for downstream handlers.
 */

import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { verifyAccessToken } from "../auth/jwt.js";
import type { AccessTokenPayload } from "../auth/types.js";
import { getDb } from "../db/index.js";
import { sessions } from "../db/sessions-schema.js";

declare global {
  namespace Express {
    interface Locals {
      auth?: AccessTokenPayload;
    }
  }
}

/**
 * Require a valid JWT access token.
 *
 * Responds 401 if:
 *   - No Authorization header
 *   - Not a Bearer token
 *   - Token is invalid, expired, or tampered
 *
 * On success, sets `res.locals.auth` with the verified payload
 * containing `{ sub: userId, deviceId, sid: sessionId }`.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "MISSING_TOKEN" });
    return;
  }

  const token = header.slice(7);
  if (!token) {
    res.status(401).json({ error: "EMPTY_TOKEN" });
    return;
  }

  let payload: AccessTokenPayload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    res.status(401).json({ error: "INVALID_TOKEN" });
    return;
  }

  // A valid signature is not enough: log-off (/linking/logoff), new-phone
  // login (§7.3 handoff) and refresh-token reuse all revoke the SESSION, and
  // an access token from a revoked session must stop working at once, not
  // when it expires up to an hour later (WEB-R1.6 / WEB-R1.8; same check the
  // socket handshake already does, TAD §9.5).
  try {
    const [session] = await getDb()
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, payload.sid))
      .limit(1);
    if (session?.revokedAt) {
      res.status(401).json({ error: "SESSION_REVOKED" });
      return;
    }
  } catch {
    res.status(503).json({ error: "AUTH_UNAVAILABLE" });
    return;
  }

  res.locals.auth = payload;
  next();
}
