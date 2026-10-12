import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** QR code + share link for joining a session (works through port forwarding too). */
export default function InviteCard({ joinCode }: { joinCode: string }) {
  const [qrSvg, setQrSvg] = useState('');
  const [copied, setCopied] = useState(false);
  const joinUrl = `${window.location.origin}/?join=${joinCode}`;

  useEffect(() => {
    QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then(setQrSvg)
      .catch(() => setQrSvg(''));
  }, [joinUrl]);

  async function shareLink() {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my game', text: `Join code ${joinCode}`, url: joinUrl });
      } else {
        await navigator.clipboard.writeText(joinUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user cancelled the share sheet */
    }
  }

  if (!qrSvg) return null;
  return (
    <div className="join-qr">
      <div className="join-qr__code" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <div className="join-qr__text">
        <p>
          Scan to join, or share the link. Code <strong className="join-qr__code-text">{joinCode}</strong>
        </p>
        <button className="btn btn--secondary btn--sm" onClick={shareLink}>
          {copied ? 'Link copied ✓' : 'Share link'}
        </button>
      </div>
    </div>
  );
}
