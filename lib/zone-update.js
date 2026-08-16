export function assertZoneSnapshotHealthy({ features, previousCount = null }) {
  if (!Array.isArray(features) || features.length < 5) {
    throw new Error(`동구 주요상권 수가 비정상입니다: ${features?.length ?? 0}`);
  }
  const numbers = new Set();
  for (const feature of features) {
    const number = String(feature?.properties?.no || "");
    if (!number || numbers.has(number)) throw new Error(`상권번호가 없거나 중복되었습니다: ${number || "(없음)"}`);
    if (!["Polygon", "MultiPolygon"].includes(feature?.geometry?.type)) {
      throw new Error(`지원하지 않는 상권 도형입니다: ${feature?.geometry?.type || "(없음)"}`);
    }
    const polygons = feature.geometry.type === "MultiPolygon"
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];
    const validRing = (ring) => {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      if (!ring.every((point) => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite))) return false;
      const first = ring[0];
      const last = ring[ring.length - 1];
      return first[0] === last[0] && first[1] === last[1];
    };
    const valid = Array.isArray(polygons) && polygons.length > 0
      && polygons.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing));
    if (!valid) throw new Error(`상권 도형 좌표가 비어 있거나 올바르지 않습니다: ${number}`);
    numbers.add(number);
  }
  if (Number.isInteger(previousCount) && previousCount > 0 && features.length < previousCount * 0.8) {
    throw new Error(`기존 주요상권 대비 20% 이상 감소했습니다: ${previousCount} -> ${features.length}`);
  }
}
