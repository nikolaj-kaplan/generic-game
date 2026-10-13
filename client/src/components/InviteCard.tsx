import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** This machine's network address, set by vite.config.ts ('' when the app is not exposed). */
declare const __LAN_HOST__: string;

/** A host that only works on this machine; a phone that scans it would look at itself. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

function joinUrlFor(joinCode: string): string {
  const { protocol, hostname, port } = window.location;
  const host = LOCAL_HOSTS.includes(hostname) && __LAN_HOST__ ? __LAN_HOST__ : hostname;
  return `${protocol}//${host}${port ? `:${port}` : ''}/?join=${joinCode}`;
}

/** The join QR code as an SVG string (empty until rendered). */
function useQrSvg(url: string): string {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [url]);
  return svg;
}

function ShareButton({ joinCode }: { joinCode: string }) {
  const [copied, setCopied] = useState(false);
  async function shareLink() {
    const url = joinUrlFor(joinCode);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my game', text: `Join code ${joinCode}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user cancelled the share sheet */
    }
  }
  return (
    <button className="btn btn--secondary btn--sm" onClick={shareLink}>
      {copied ? 'Link copied ✓' : 'Share link'}
    </button>
  );
}

/** QR code + share link for joining a session (works through port forwarding too). Tap the code to enlarge it. */
export default function InviteCard({ joinCode, players }: { joinCode: string; players?: string[] }) {
  const qrSvg = useQrSvg(joinUrlFor(joinCode));
  const [big, setBig] = useState(false);

  if (!qrSvg) return null;
  return (
    <div className="join-qr">
      {big && <InvitePopup joinCode={joinCode} players={players} onClose={() => setBig(false)} />}
      <button className="join-qr__code" onClick={() => setBig(true)} aria-label="Show the QR code full screen" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <div className="join-qr__text">
        <p>
          Scan to join, or share the link. Code <strong className="join-qr__code-text">{joinCode}</strong>
        </p>
        <div className="join-qr__actions">
          <ShareButton joinCode={joinCode} />
          <button className="btn btn--secondary btn--sm" onClick={() => setBig(true)}>
            Show big
          </button>
        </div>
      </div>
    </div>
  );
}

/** Full-screen QR code to hold up for others to scan. Any player can open it. */
export function InvitePopup({ joinCode, players, onClose }: { joinCode: string; players?: string[]; onClose: () => void }) {
  const joinUrl = joinUrlFor(joinCode);
  const qrSvg = useQrSvg(joinUrl);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="invite-overlay" onClick={onClose}>
      <div className="invite-popup" role="dialog" aria-modal="true" aria-label="Invite players" onClick={(e) => e.stopPropagation()}>
        <p className="invite-popup__title">Scan to join</p>
        <div className="invite-popup__qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <p className="invite-popup__label">or open {new URL(joinUrl).host} and enter</p>
        <p className="invite-popup__code">{joinCode}</p>
        {players && players.length > 0 && (
          <p className="invite-popup__players">
            {players.length} here: {players.join(', ')}
          </p>
        )}
        <div className="invite-popup__actions">
          <ShareButton joinCode={joinCode} />
          <button className="btn btn--primary btn--sm" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
