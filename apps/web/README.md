# @wpt/web

Next.js app for WPT on the computer. All backend calls go through
`@wpt/api-client`; request, response and push shapes live in
`packages/shared/src/linking.ts` (the WEB-R1.0 contract, shared with BE-6.1).

## Run

```bash
pnpm install
pnpm --filter @wpt/api-client mock   # WEB-R1.0 mock on :4010
pnpm --filter web dev                # Web on :3000
```

Open http://localhost:3000 for the QR, and http://localhost:4010/__mock to act
as the phone: scan the pending QR, take the phone offline/online, or simulate
a new-phone login (`force_logout`).

To use the real backend (BE-6.1) instead, set `API_BASE_URL=http://localhost:4000`
in `.env.local`. That is the only change needed.

## Verify

```bash
pnpm --filter web build                  # zero errors, zero warnings
pnpm --filter web test                   # @wpt/crypto + @wpt/api-client resolve (WEB-R1.1)
pnpm --filter @wpt/api-client test       # mock behaviours (1)–(5) (WEB-R1.0)
```

## Flow (TAD §12.1)

1. Web generates a linking token (`crypto.getRandomValues`) and its identity bundle.
2. It registers both on the linking channel and only renders the QR after the ack.
3. The QR is replaced every 60s; the server rejects an old token with `TOKEN_EXPIRED`.
4. The phone scans; the backend pushes access + refresh tokens down the same channel.
5. Web lands on the chat list. It keeps working when the phone is offline (WEB-R1.4).

## Session lifecycle

| Event | What happens |
| --- | --- |
| Phone offline / Web reconnects (R1.4, R1.5) | Nothing visible. Queued messages drain into the background inbox; a capped drain (`queue_more`) is finished with `/relay/poll`. No syncing UI or console output. |
| **Log out** (R1.6) | Session ends in this browser at once and `/linking/logoff` revokes it server-side. Offline? The request is queued and re-sent on start, on `online`, and every 30s until the server confirms. Old access and refresh tokens are rejected afterwards. |
| **Close the tab** (R1.7) | Nothing. The session is kept in `localStorage` and resumes on reopen with no rescan. |
| **New-phone login** (R1.8) | The backend revokes every session, pushes `force_logout` and closes the socket. Web immediately shows "session ended, scan again". |

Private/incognito windows discard `localStorage` when closed, so there a
closed window needs a rescan. That is expected browser behaviour, not a bug.
