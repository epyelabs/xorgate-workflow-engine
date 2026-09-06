async function handler(event, context) {
  const forklifts = event.payload.boxes.filter((b) => b.cls === "forklift")
  if (forklifts.length === 0) return null // nothing to record for this frame
  const widest = forklifts.reduce((a, b) => (width(b) > width(a) ? b : a))
  return {
    frameSeq: event.payload.frameSeq,
    count: forklifts.length,
    widestPx: Math.round(width(widest)),
    confidence: widest.confidence,
  }
}

function width(box) {
  const [x1, , x2] = box.xyxy
  return x2 - x1
}
