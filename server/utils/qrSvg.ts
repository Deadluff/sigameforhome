/**
 * Join-link QR code as SVG. Reuses the QR encoder that qrcode-terminal already ships,
 * so the lobby QR needs no extra dependency.
 */
// @ts-expect-error The vendored encoder is plain CommonJS without type declarations.
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
// @ts-expect-error Same vendored package as above.
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

interface QrMatrix {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

export function qrSvg(text: string): string {
  const qr: QrMatrix = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  // A four-module quiet zone is what phone cameras need to lock on.
  const quiet = 4;
  const full = size + quiet * 2;
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
