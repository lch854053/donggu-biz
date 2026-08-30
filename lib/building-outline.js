import { pointInGeometry } from "./market.js";

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
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ko"))[0]?.[0] || null;
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
    if (!matches.size) continue;
    matchedStoreIds.add(String(store.id || ""));
    const industry = String(store.largeName || "기타").trim() || "기타";
    for (const feature of matches.values()) {
      if (!countsByFeature.has(String(feature.id))) countsByFeature.set(String(feature.id), new Map());
      const counts = countsByFeature.get(String(feature.id));
      counts.set(industry, (counts.get(industry) || 0) + 1);
    }
  }

  return {
    byId: new Map([...countsByFeature.entries()].map(([id, counts]) => [id, dominantIndustry(counts)])),
    matchedStoreIds
  };
}
