// 캔버스 이미지 카드 공용 헬퍼 — 인스타 공유용 이미지 생성에 사용
export const CANVAS_FONT = '"Pretendard Variable", Pretendard, sans-serif';

export function roundRect(x, px, py, w, h, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

export function drawPill(x, px, py, text, bg, fg, fontSize = 26) {
  x.font = `700 ${fontSize}px ${CANVAS_FONT}`;
  const tw = x.measureText(text).width;
  const h = fontSize * 1.77;
  x.fillStyle = bg;
  roundRect(x, px, py - h * 0.65, tw + fontSize * 1.4, h, h / 2);
  x.fill();
  x.fillStyle = fg;
  x.fillText(text, px + fontSize * 0.7, py);
  return px + tw + fontSize * 1.4 + 12;
}

export function downloadCanvas(canvas, filename, onDone) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    if (onDone) onDone();
  }, 'image/png');
}
