// Settings › Devices: the phones paired with this keel (keel's Android app), Remove (asks first, in the page), and
// "Pair a phone": a one-time code as a QR code for the address the phone uses (Wi-Fi, Tailscale or a tunnel), with
// its countdown. The QR code is made here, in the page. When keel only answers on this computer, it says how to
// open it to a phone (keel2 start --wifi, keel2 share tailscale).

import { useCallback, useEffect, useRef, useState } from "react";
import { errorParts } from "../api";
import {
  devicesApi,
  type Device,
  type Pairing,
  type PairUrl,
} from "../devicesApi";
import { agoText } from "../format";
import { QrCode } from "./QrCode";
import { Confirm, ErrorBox } from "./ui";

const KIND_LABEL: Record<string, string> = {
  wifi: "Wi-Fi",
  tailscale: "Tailscale",
  tunnel: "Tunnel (public)",
  local: "This computer",
};
const kindLabel = (k: string) => KIND_LABEL[k] ?? k;
const PLATFORM: Record<string, string> = { android: "Android", ios: "iOS" };

/** "9:41" left of a code, from its expiry. */
export function countdown(expiresAt: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Err = { message: string; hint?: string } | null;

export function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [err, setErr] = useState<Err>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pick, setPick] = useState(0);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [paired, setPaired] = useState<string | null>(null);
  const known = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const list = await devicesApi.list();
      setDevices(list);
      setErr(null);
      return list;
    } catch (e) {
      setErr(errorParts(e));
      return null;
    }
  }, []);
  useEffect(() => {
    void load().then((l) => {
      if (l) known.current = new Set(l.map((d) => d.id));
    });
  }, [load]);

  // while a code is shown: the countdown, and the list now and then, so the new phone shows up when it pairs
  useEffect(() => {
    if (!pairing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void load().then((l) => {
        const fresh = l?.find((d) => !known.current.has(d.id));
        if (fresh) {
          known.current = new Set(l!.map((d) => d.id));
          setPairing(null);
          setPaired(fresh.name);
        }
      });
    }, 3000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [pairing, load]);

  const startPairing = async () => {
    setBusy(true);
    setPaired(null);
    try {
      const p = await devicesApi.pairing();
      known.current = new Set((devices ?? []).map((d) => d.id));
      setPairing(p);
      setPick(0);
      setNow(Date.now());
      setErr(null);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: Device) => {
    setBusy(true);
    try {
      await devicesApi.remove(d.id);
      setAsking(null);
      await load();
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };

  const url: PairUrl | undefined =
    pairing?.urls[Math.min(pick, (pairing?.urls.length ?? 1) - 1)];
  const left = pairing ? Date.parse(pairing.expiresAt) - now : 0;
  const expired = !!pairing && left <= 0;
  const reachable = pairing
    ? (pairing.reachable ?? pairing.urls.some((u) => u.kind !== "local"))
    : true;

  return (
    <div className="pdv" data-testid="devices">
      {err && (
        <div className="pdv-pad">
          <ErrorBox error={err} onRetry={() => void load()} />
        </div>
      )}
      {devices === null && !err && (
        <p className="pdv-pad sub">Loading devices…</p>
      )}
      {devices !== null &&
        (devices.length === 0 ? (
          <p className="pdv-pad sub">No phone is paired yet.</p>
        ) : (
          <ul className="pdv-list" aria-label="Paired devices">
            {devices.map((d) => (
              <li key={d.id} className="pdv-row">
                <div className="pdv-lab">
                  <b>{d.name}</b>
                  <span className="sub">
                    {PLATFORM[d.platform] ?? d.platform}
                    {" · "}last seen{" "}
                    {d.lastSeenAt ? agoText(d.lastSeenAt) : "never"}
                    {d.lastIp ? (
                      <>
                        {" "}
                        · <span className="mono">{d.lastIp}</span>
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="pdv-ctl">
                  {asking === d.id ? (
                    <Confirm
                      text={`Remove ${d.name}? It is signed out at once and has to pair again.`}
                      yes="Remove"
                      busy={busy}
                      onYes={() => void remove(d)}
                      onNo={() => setAsking(null)}
                    />
                  ) : (
                    <button
                      className="btn sm"
                      type="button"
                      aria-label={`Remove ${d.name}`}
                      onClick={() => setAsking(d.id)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}
      {paired && (
        <p className="pdv-pad pdv-ok" role="status">
          Paired: {paired}
        </p>
      )}
      <div className="pdv-pad pdv-pair">
        {!pairing && (
          <button
            className="btn primary sm"
            type="button"
            onClick={() => void startPairing()}
            disabled={busy}
          >
            Pair a phone
          </button>
        )}
        {pairing && url && (
          <div className="pdv-qr" aria-label="Pair a phone" role="group">
            {!reachable && (
              <p className="pdv-hint" role="note">
                keel only answers on this computer (127.0.0.1), so a phone
                cannot reach it yet. Start keel with{" "}
                <code>keel2 start --wifi</code> or{" "}
                <code>keel2 share tailscale</code> so a phone can reach it, then
                make a new code.
              </p>
            )}
            {pairing.urls.length > 1 && (
              <div
                className="tabs"
                role="radiogroup"
                aria-label="Address for the phone"
              >
                {pairing.urls.map((u, i) => (
                  <button
                    key={u.url}
                    type="button"
                    role="radio"
                    aria-checked={i === pick}
                    onClick={() => setPick(i)}
                  >
                    {kindLabel(u.kind)}
                  </button>
                ))}
              </div>
            )}
            {expired ? (
              <p className="pdv-hint" role="status">
                This code expired. Make a new one.
              </p>
            ) : (
              <QrCode text={url.qr} label={`Pairing QR code for ${url.url}`} />
            )}
            <div className="pdv-facts">
              <span>Address</span>
              <b className="mono" data-testid="pair-url">
                {url.url}
              </b>
              <span>Code</span>
              <b className="mono">{pairing.code}</b>
              <span>Valid for</span>
              <b data-testid="pair-left">
                {expired ? "expired" : countdown(pairing.expiresAt, now)}
              </b>
            </div>
            {url.kind === "tunnel" && (
              <p className="sub">
                This address is public: anyone with it reaches keel's sign-in
                and pairing, nothing more.
              </p>
            )}
            {url.kind === "wifi" && (
              <p className="sub">
                Plain http inside your Wi-Fi. The phone must be on the same
                network.
              </p>
            )}
            <p className="sub">
              In keel's Android app: Pair › scan this code. It works once.
            </p>
            <div className="row">
              <button
                className="btn sm"
                type="button"
                onClick={() => void startPairing()}
                disabled={busy}
              >
                New code
              </button>
              <button
                className="btn sm ghost"
                type="button"
                onClick={() => setPairing(null)}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
