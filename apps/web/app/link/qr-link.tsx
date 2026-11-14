"use client";

/**
 * WEB-R1.2 / WEB-R1.3: QR linking screen.
 *
 * Flow (TAD §12.1):
 *   1. Web generates the linking token (CSPRNG) and its identity bundle.
 *   2. It REGISTERS both over the linking channel and waits for the ack.
 *   3. Only then is the token rendered as a QR (npm `qrcode`).
 *   4. The phone scans; the backend PUSHES credentials down the channel;
 *      Web saves them and moves to the chat list.
 *
 * Expiry: a fresh token every 60s, measured from just BEFORE registering,
 * so Web always retires a token no later than the server does. The server
 * enforces the TTL itself (and a late scan gets TOKEN_EXPIRED).
 *
 * Flicker (TEST-3.1): each token's QR markup is generated once and memoized.
 * The 1s countdown lives in its own component, so its ticks never re-render
 * the code.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { LINKING_TOKEN_TTL_MS, type LinkedPayload } from "@wpt/shared";
import { createLinkingChannel, createLinkingToken, LinkingError, type LinkingChannel } from "@wpt/api-client";
import { API_BASE_URL } from "../lib/api";
import { getOrCreateIdentity } from "../lib/identity";

type View =
  | { kind: "loading" }
  | { kind: "ready"; token: string; svg: string; rotateAt: number }
  | { kind: "retry" };

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

export function QrLink({ onLinked, notice }: { onLinked: (p: LinkedPayload) => void; notice?: string }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const channelRef = useRef<LinkingChannel | null>(null);
  const currentRef = useRef<{ token: string; rotateAt: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);
  const cycleRef = useRef<() => void>(() => {});
  // A ref, not an effect dependency: a parent re-render with a new callback
  // must never tear down the channel and swap the QR.
  const onLinkedRef = useRef(onLinked);
  useEffect(() => {
    onLinkedRef.current = onLinked;
  }, [onLinked]);

  const schedule = useCallback((ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => cycleRef.current(), ms);
  }, []);

  const cycle = useCallback(async () => {
    const channel = channelRef.current;
    if (!channel) return;
    const token = createLinkingToken();
    // Clock starts before the request, so Web's deadline ≤ the server's.
    const rotateAt = Date.now() + LINKING_TOKEN_TTL_MS;
    currentRef.current = null;
    try {
      await channel.register(token, getOrCreateIdentity());
      // Registered: now (and only now) it is safe to show.
      const svg = await QRCode.toString(token, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      if (channelRef.current !== channel) return; // unmounted meanwhile
      failuresRef.current = 0;
      currentRef.current = { token, rotateAt };
      setView({ kind: "ready", token, svg, rotateAt });
      schedule(Math.max(0, rotateAt - Date.now()));
    } catch (err) {
      if (channelRef.current !== channel) return;
      const code = err instanceof LinkingError ? err.code : "UNKNOWN";
      if (code === "TOKEN_EXPIRED" || code === "TOKEN_ALREADY_USED") {
        schedule(0); // can't happen for a fresh token; just make another
        return;
      }
      // Channel unreachable / timed out: retry state, never a blank screen.
      setView({ kind: "retry" });
      const delay = RETRY_DELAYS_MS[Math.min(failuresRef.current, RETRY_DELAYS_MS.length - 1)]!;
      failuresRef.current += 1;
      schedule(delay);
    }
  }, [schedule]);

  useEffect(() => {
    cycleRef.current = () => void cycle();
  }, [cycle]);

  useEffect(() => {
    const channel = createLinkingChannel({ baseUrl: API_BASE_URL });
    channelRef.current = channel;

    const offLinked = channel.onLinked((payload) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      onLinkedRef.current(payload);
    });
    // Server says a token died. Our own timer normally retires it first;
    // only act if the CURRENT token is at/after its deadline, so a late push
    // for an already-replaced token can't cause a second, flickering swap.
    const offExpired = channel.onExpired(() => {
      const cur = currentRef.current;
      if (cur && Date.now() >= cur.rotateAt - 2_000) schedule(0);
    });

    void cycle();

    return () => {
      offLinked();
      offExpired();
      if (timerRef.current) clearTimeout(timerRef.current);
      channelRef.current = null;
      channel.close();
    };
  }, [cycle, schedule]);

  return (
    <main className="link-page">
      <section className="link-card" aria-live="polite">
        <div className="link-text">
          <h1>Use WPT on your computer</h1>
          {notice ? <p className="notice">{notice}</p> : null}
          <ol>
            <li>Open WPT on your phone</li>
            <li>Go to Settings → Linked devices → Link a device</li>
            <li>Point your phone at this screen to scan the code</li>
          </ol>
        </div>
        <div className="qr-slot">
          {view.kind === "ready" ? (
            <>
              <QrImage key={view.token} svg={view.svg} />
              <Countdown key={`c-${view.token}`} until={view.rotateAt} />
            </>
          ) : view.kind === "retry" ? (
            <div className="qr-placeholder" role="alert">
              <p>Can’t reach WPT right now.</p>
              <button type="button" onClick={() => schedule(0)}>
                Try again
              </button>
            </div>
          ) : (
            <div className="qr-placeholder">
              <span className="spinner" aria-hidden />
              <p>Generating code…</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

/** Rendered once per token; memo keeps countdown ticks from repainting it. */
const QrImage = memo(function QrImage({ svg }: { svg: string }) {
  return <div className="qr" role="img" aria-label="Linking QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
});

function Countdown({ until }: { until: number }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 1_000);
    return () => clearInterval(t);
  }, [until]);
  return <p className="countdown">Code refreshes in {left}s</p>;
}
