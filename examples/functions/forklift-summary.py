def handler(event, context):
    forklifts = [b for b in event["payload"]["boxes"] if b["cls"] == "forklift"]
    if not forklifts:
        return None
    widest = max(forklifts, key=lambda b: b["xyxy"][2] - b["xyxy"][0])
    return {
        "frameSeq": event["payload"]["frameSeq"],
        "count": len(forklifts),
        "widestPx": round(widest["xyxy"][2] - widest["xyxy"][0]),
        "confidence": widest["confidence"],
    }
