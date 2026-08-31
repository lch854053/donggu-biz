import { pointInGeometry } from "./market.js";

const SAME_LOT_DISTANCE_METERS = 20;
const UNIQUE_NEAREST_DISTANCE_METERS = 10;
const UNIQUE_NEAREST_MARGIN_METERS = 2;

export function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (value) => {
    if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") {
      bounds[0] = Math.min(bounds[0], value[0]);
      bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]);
      bounds[3] = Math.max(bounds[3], value[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
  };
  walk(geometry?.coordinates);
  return Number.isFinite(bounds[0]) ? bounds : null;
}

export function boundsIntersect(a, b) {
  return Boolean(a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]);
}

export function geometryCenter(geometry) {
  const bounds = geometryBounds(geometry);
  return bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : null;
}

function geometryRings(geometry) {
  const polygons = geometry?.type === "MultiPolygon"
    ? geometry.coordinates
    : geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : [];
  return polygons.flatMap((polygon) => polygon || []);
}

function crossProduct(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point, start, end) {
  return Math.abs(crossProduct(start, end, point)) <= 1e-12
    && point[0] >= Math.min(start[0], end[0]) - 1e-12
    && point[0] <= Math.max(start[0], end[0]) + 1e-12
    && point[1] >= Math.min(start[1], end[1]) - 1e-12
    && point[1] <= Math.max(start[1], end[1]) + 1e-12;
}

function segmentsIntersect(leftStart, leftEnd, rightStart, rightEnd) {
  const leftStartSide = crossProduct(leftStart, leftEnd, rightStart);
  const leftEndSide = crossProduct(leftStart, leftEnd, rightEnd);
  const rightStartSide = crossProduct(rightStart, rightEnd, leftStart);
  const rightEndSide = crossProduct(rightStart, rightEnd, leftEnd);
  const crosses = (first, second) => (first > 1e-12 && second < -1e-12) || (first < -1e-12 && second > 1e-12);
  if (crosses(leftStartSide, leftEndSide) && crosses(rightStartSide, rightEndSide)) return true;
  return (Math.abs(leftStartSide) <= 1e-12 && pointOnSegment(rightStart, leftStart, leftEnd))
    || (Math.abs(leftEndSide) <= 1e-12 && pointOnSegment(rightEnd, leftStart, leftEnd))
    || (Math.abs(rightStartSide) <= 1e-12 && pointOnSegment(leftStart, rightStart, rightEnd))
    || (Math.abs(rightEndSide) <= 1e-12 && pointOnSegment(leftEnd, rightStart, rightEnd));
}

export function geometryIntersects(left, right) {
  if (!left || !right || !boundsIntersect(geometryBounds(left), geometryBounds(right))) return false;
  const leftRings = geometryRings(left);
  const rightRings = geometryRings(right);
  if (!leftRings.length || !rightRings.length) return false;
  if (leftRings.some((ring) => ring.some(([longitude, latitude]) => pointInGeometry(longitude, latitude, right)))) return true;
  if (rightRings.some((ring) => ring.some(([longitude, latitude]) => pointInGeometry(longitude, latitude, left)))) return true;
  return leftRings.some((leftRing) => leftRing.some((leftPoint, index) => {
    const nextLeftPoint = leftRing[(index + 1) % leftRing.length];
    return rightRings.some((rightRing) => rightRing.some((rightPoint, rightIndex) => (
      segmentsIntersect(leftPoint, nextLeftPoint, rightPoint, rightRing[(rightIndex + 1) % rightRing.length])
    )));
  }));
}

function clipRingToBounds(ring, bounds) {
  let points = ring.slice(0, -1);
  if (points.length < 3) return null;
  const edges = [
    {
      inside: ([longitude]) => longitude >= bounds[0],
      intersect: (start, end) => [bounds[0], start[1] + (end[1] - start[1]) * (bounds[0] - start[0]) / (end[0] - start[0])]
    },
    {
      inside: ([longitude]) => longitude <= bounds[2],
      intersect: (start, end) => [bounds[2], start[1] + (end[1] - start[1]) * (bounds[2] - start[0]) / (end[0] - start[0])]
    },
    {
      inside: ([, latitude]) => latitude >= bounds[1],
      intersect: (start, end) => [start[0] + (end[0] - start[0]) * (bounds[1] - start[1]) / (end[1] - start[1]), bounds[1]]
    },
    {
      inside: ([, latitude]) => latitude <= bounds[3],
      intersect: (start, end) => [start[0] + (end[0] - start[0]) * (bounds[3] - start[1]) / (end[1] - start[1]), bounds[3]]
    }
  ];
  for (const edge of edges) {
    const clipped = [];
    let previous = points.at(-1);
    let previousInside = edge.inside(previous);
    for (const current of points) {
      const currentInside = edge.inside(current);
      if (currentInside !== previousInside) clipped.push(edge.intersect(previous, current));
      if (currentInside) clipped.push(current);
      previous = current;
      previousInside = currentInside;
    }
    points = clipped;
    if (points.length < 3) return null;
  }
  const cleaned = points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    return point[0] !== previous[0] || point[1] !== previous[1];
  });
  if (cleaned.length < 3) return null;
  cleaned.push(cleaned[0]);
  return cleaned;
}

export function expandBoundsMeters(bounds, meters) {
  if (!bounds || !Number.isFinite(meters) || meters < 0) return null;
  const meanLatitude = (bounds[1] + bounds[3]) / 2;
  const latitudeDelta = meters / 110540;
  const longitudeDelta = meters / (111320 * Math.cos(meanLatitude * Math.PI / 180));
  return [
    bounds[0] - longitudeDelta,
    bounds[1] - latitudeDelta,
    bounds[2] + longitudeDelta,
    bounds[3] + latitudeDelta
  ];
}

export function clipGeometryToBounds(geometry, bounds) {
  if (!geometry || !bounds || !["Polygon", "MultiPolygon"].includes(geometry.type)) return null;
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  const clippedPolygons = polygons.map((polygon) => {
    const rings = (polygon || []).map((ring) => clipRingToBounds(ring, bounds)).filter(Boolean);
    return rings.length ? rings : null;
  }).filter(Boolean);
  if (!clippedPolygons.length) return null;
  return clippedPolygons.length === 1
    ? { type: "Polygon", coordinates: clippedPolygons[0] }
    : { type: "MultiPolygon", coordinates: clippedPolygons };
}

function pointSegmentDistanceMeters(longitude, latitude, start, end) {
  const longitudeScale = 111320 * Math.cos(latitude * Math.PI / 180);
  const latitudeScale = 110540;
  const ax = (start[0] - longitude) * longitudeScale;
  const ay = (start[1] - latitude) * latitudeScale;
  const bx = (end[0] - longitude) * longitudeScale;
  const by = (end[1] - latitude) * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
  return Math.hypot(ax + ratio * dx, ay + ratio * dy);
}

export function geometryDistanceMeters(longitude, latitude, geometry) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return Infinity;
  if (pointInGeometry(longitude, latitude, geometry)) return 0;
  let minimum = Infinity;
  for (const ring of geometryRings(geometry)) {
    for (let index = 1; index < ring.length; index += 1) {
      minimum = Math.min(minimum, pointSegmentDistanceMeters(longitude, latitude, ring[index - 1], ring[index]));
    }
  }
  return minimum;
}

export function filterBuildingsInZone(features, zoneGeometry) {
  return (features || []).filter((feature) => {
    const center = geometryCenter(feature?.geometry);
    return center && pointInGeometry(center[0], center[1], zoneGeometry);
  });
}

function pnuKeys(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const current = raw.startsWith("29110") ? `12210${raw.slice(5)}` : raw;
  const legacy = raw.startsWith("12210") ? `29110${raw.slice(5)}` : raw;
  return [...new Set([raw, current, legacy])];
}

function dominantIndustry(counts) {
  const known = [...counts.entries()].filter(([name]) => name !== "업종 미확인");
  return (known.length ? known : [...counts.entries()])
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ko"))[0]?.[0] || null;
}

function lotKey(value) {
  return pnuKeys(value).find((key) => key.startsWith("12210") && key.length >= 15)?.slice(0, 15) || null;
}

function nearestBuildingMatches(features, store) {
  if (!Number.isFinite(store?.longitude) || !Number.isFinite(store?.latitude)) return [];
  const storeLot = lotKey(store.pnu) || lotKey(store.legacyPnu);
  const ranked = (storeLot
    ? features.filter((feature) => lotKey(feature?.properties?.pnu) === storeLot)
    : features)
    .map((feature) => ({ feature, distance: geometryDistanceMeters(store.longitude, store.latitude, feature.geometry) }))
    .sort((left, right) => left.distance - right.distance);
  const nearest = ranked[0];
  if (nearest && nearest.distance <= SAME_LOT_DISTANCE_METERS && storeLot) return [nearest.feature];

  const allRanked = features
    .map((feature) => ({ feature, distance: geometryDistanceMeters(store.longitude, store.latitude, feature.geometry) }))
    .sort((left, right) => left.distance - right.distance);
  const allNearest = allRanked[0];
  const nextNearest = allRanked[1];
  if (allNearest
    && allNearest.distance <= UNIQUE_NEAREST_DISTANCE_METERS
    && (!nextNearest || nextNearest.distance - allNearest.distance >= UNIQUE_NEAREST_MARGIN_METERS)) {
    return [allNearest.feature];
  }
  return [];
}

export function matchBuildingIndustries(features, stores) {
  const featuresByPnu = new Map();
  for (const feature of features || []) {
    for (const key of pnuKeys(feature?.properties?.pnu)) {
      if (!featuresByPnu.has(key)) featuresByPnu.set(key, []);
      featuresByPnu.get(key).push(feature);
    }
  }

  const countsByFeature = new Map();
  const storesByFeature = new Map();
  const matchedStoreIds = new Set();
  for (const store of stores || []) {
    const matches = new Map();
    for (const key of [...pnuKeys(store?.pnu), ...pnuKeys(store?.legacyPnu)]) {
      for (const feature of featuresByPnu.get(key) || []) matches.set(String(feature.id), feature);
    }
    if (!matches.size && Number.isFinite(store?.longitude) && Number.isFinite(store?.latitude)) {
      for (const feature of features || []) {
        if (pointInGeometry(store.longitude, store.latitude, feature.geometry)) matches.set(String(feature.id), feature);
      }
    }
    if (!matches.size) {
      for (const feature of nearestBuildingMatches(features || [], store)) matches.set(String(feature.id), feature);
    }
    if (!matches.size) continue;
    matchedStoreIds.add(String(store.id || ""));
    const industry = String(store.largeName || "").trim();
    const industryName = industry || "업종 미확인";
    for (const feature of matches.values()) {
      if (!countsByFeature.has(String(feature.id))) countsByFeature.set(String(feature.id), new Map());
      const counts = countsByFeature.get(String(feature.id));
      counts.set(industryName, (counts.get(industryName) || 0) + 1);
      if (!industry) continue;
      if (!storesByFeature.has(String(feature.id))) storesByFeature.set(String(feature.id), []);
      const featureStores = storesByFeature.get(String(feature.id));
      const storeId = String(store.id || "");
      if (!storeId || !featureStores.some((candidate) => String(candidate.id || "") === storeId)) featureStores.push(store);
    }
  }

  return {
    byId: new Map([...countsByFeature.entries()].map(([id, counts]) => [id, dominantIndustry(counts)])),
    storesById: storesByFeature,
    matchedStoreIds
  };
}
