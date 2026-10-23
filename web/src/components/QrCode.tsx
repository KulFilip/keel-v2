// A QR code drawn as one SVG path (qrcode-generator makes the matrix; nothing leaves the page).

import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** The dark modules of [text] as a QR matrix (error correction M, the smallest version that fits). */
export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

export function QrCode({ text, size = 220, label }: { text: string; size?: number; label: string }) {
  const { n, d } = useMemo(() => {
    const m = qrMatrix(text);
    let path = "";
    m.forEach((row, r) => row.forEach((dark, c) => { if (dark) path += `M${c + 4} ${r + 4}h1v1h-1z`; }));
    return { n: m.length + 8, d: path };   // a quiet zone of 4 modules on every side
  }, [text]);
  return (
    <svg className="qr" role="img" aria-label={label} data-qr={text} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
