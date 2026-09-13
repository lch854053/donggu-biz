// 상권 지도의 주소 반경 조회 계산. 좌표 필터와 업종·폐업 집계만 담당하며,
// 지도 그리기와 화면 갱신은 app.js가 한다.

const EARTH_RADIUS_M = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;

export const AREA_SHAPES = Object.freeze({
  circle: "circle",
  square: "square"
});

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 정사각형은 중심에서 반경만큼 떨어진 축에 정렬된 변(한 변 = 반경×2)으로 본다.
// 경도 거리는 중심 위도의 코사인으로 보정한다.
export function pointInArea(latitude, longitude, center, { shape = AREA_SHAPES.circle, radiusM = 300 } = {}) {
  if (!center || !Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (!Number.isFinite(radiusM) || radiusM <= 0) return false;
  if (shape === AREA_SHAPES.square) {
    const latMeters = (latitude - center.latitude) * 111320;
    const lngMeters = (longitude - center.longitude) * 111320 * Math.cos(center.latitude * DEG_TO_RAD);
    return Math.abs(latMeters) <= radiusM && Math.abs(lngMeters) <= radiusM;
  }
  return haversineMeters(center.latitude, center.longitude, latitude, longitude) <= radiusM;
}

export function filterRowsInArea(rows, center, options = {}) {
  return (rows || []).filter((row) => pointInArea(row.latitude, row.longitude, center, options));
}

function countByName(rows, field) {
  const counts = new Map();
  for (const row of rows || []) {
    const name = String(row[field] ?? "").trim() || "미분류";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function aggregateIndustries(rows) {
  return {
    large: countByName(rows, "largeName"),
    small: countByName(rows, "smallName")
  };
}

// 반경 안의 영업 중 업소와 폐업 기록을 업종 대분류별로 한 표로 묶는다.
export function industryClosureTable(activeRows, closedRows) {
  const active = countByName(activeRows, "largeName");
  const closed = new Map(countByName(closedRows, "largeName").map((row) => [row.name, row.count]));
  const names = new Set([...active.map((row) => row.name), ...closed.keys()]);
  return [...names].map((name) => {
    const activeCount = active.find((row) => row.name === name)?.count || 0;
    const closedCount = closed.get(name) || 0;
    return {
      name,
      activeCount,
      closedCount,
      closureRate: activeCount + closedCount > 0 ? closedCount / (activeCount + closedCount) : null
    };
  }).sort((left, right) => right.activeCount - left.activeCount || right.closedCount - left.closedCount
    || left.name.localeCompare(right.name));
}

// 원형은 64각형, 정사각형은 축에 정렬한 사각형으로 근사한 GeoJSON 폴리곤.
// 상권 분석의 건물 폴리곤·통계 파이프라인이 상권 경계와 똑같이 소비할 수 있게 만든다.
const CIRCLE_VERTICES = 64;

export function areaPolygonGeometry(center, { shape = AREA_SHAPES.circle, radiusM = 300 } = {}) {
  if (!center || !Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) {
    throw new Error("중심 좌표가 필요합니다.");
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new Error("반경은 0보다 커야 합니다.");
  }
  const ring = [];
  if (shape === AREA_SHAPES.square) {
    const dLat = radiusM / 111320;
    const dLng = radiusM / (111320 * Math.cos(center.latitude * DEG_TO_RAD));
    ring.push(
      [center.longitude - dLng, center.latitude - dLat],
      [center.longitude + dLng, center.latitude - dLat],
      [center.longitude + dLng, center.latitude + dLat],
      [center.longitude - dLng, center.latitude + dLat],
      [center.longitude - dLng, center.latitude - dLat]
    );
  } else {
    for (let index = 0; index < CIRCLE_VERTICES; index += 1) {
      const angle = (index / CIRCLE_VERTICES) * 2 * Math.PI;
      // 각도 0을 동쪽으로 두고 반시계 방향으로 돈다.
      const dLatM = Math.sin(angle) * radiusM;
      const dLngM = Math.cos(angle) * radiusM;
      ring.push([
        center.longitude + dLngM / (111320 * Math.cos(center.latitude * DEG_TO_RAD)),
        center.latitude + dLatM / 111320
      ]);
    }
    ring.push(ring[0]);
  }
  return { type: "Polygon", coordinates: [ring] };
}
