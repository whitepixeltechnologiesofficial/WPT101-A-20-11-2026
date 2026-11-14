import { io, type Socket } from "socket.io-client";
import {
  SOCKET_PATH,
  SOCKET_TRANSPORT_PRIMARY,
  SOCKET_TRANSPORT_FALLBACK,
} from "@wpt/shared";

export interface RealtimeClientConfig {
  baseUrl: string;
  userId?: string;
  deviceId?: string;
  getAuthToken?: () => string | null | Promise<string | null>;
}

/**
 * §7.3 — Primary transport: WebSocket. Falls back to long-polling automatically
 * if the websocket upgrade fails (relevant on free-tier hosts that don't
 * reliably support persistent connections under load) — this is
 * socket.io's built-in behavior, we just declare the transport order.
 *
 * Auth handshake includes userId + deviceId so the server can register
 * this socket in the registry and push force_logout to old devices.
 *
 * The backend mounts socket.io at PATH `/realtime` on the default
 * namespace. (This used to connect to `${baseUrl}/realtime`, i.e. a
 * NAMESPACE called /realtime on the default path, which the backend does
 * not serve, so the connection could never authenticate.)
 *
 * `auth` is a function so every reconnect re-reads the current access
 * token (it rotates on refresh).
 */
export function createRealtimeClient(config: RealtimeClientConfig): Socket {
  return io(config.baseUrl, {
    path: SOCKET_PATH,
    transports: [SOCKET_TRANSPORT_PRIMARY, SOCKET_TRANSPORT_FALLBACK],
    auth: (cb) => {
      void Promise.resolve(config.getAuthToken?.()).then((token) => {
        const auth: Record<string, string> = {};
        if (token) auth.token = token;
        if (config.userId) auth.userId = config.userId;
        if (config.deviceId) auth.deviceId = config.deviceId;
        cb(auth);
      });
    },
  });
}
