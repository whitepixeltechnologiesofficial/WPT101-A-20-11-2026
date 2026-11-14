export const API_VERSION = "v1";

// Real-time transport per §-table: WebSocket (Socket.IO/ws) primary,
// degrade-to-polling fallback if free-tier reliability proves insufficient.
//
// NOTE: despite the name, the backend mounts socket.io with this as its
// server PATH (`new Server(http, { path: SOCKET_NAMESPACE })`), not as a
// namespace. New code should use SOCKET_PATH from ../linking.ts, which has
// the same value; this name is kept for existing callers.
export const SOCKET_NAMESPACE = "/realtime";
export const SOCKET_TRANSPORT_PRIMARY = "websocket" as const;
export const SOCKET_TRANSPORT_FALLBACK = "polling" as const;
