export function toLegacyPnu(pnu) {
  const value = String(pnu || "");
  return value.startsWith("12210") ? `29110${value.slice(5)}` : value;
}

export function compactStore(item) {
  return {
    id: String(item.bizesId || ""),
    name: String(item.bizesNm || "").trim(),
    branch: String(item.brchNm || "").trim(),
    largeCode: String(item.indsLclsCd || ""),
    largeName: String(item.indsLclsNm || "").trim(),
    middleCode: String(item.indsMclsCd || ""),
    middleName: String(item.indsMclsNm || "").trim(),
    smallCode: String(item.indsSclsCd || ""),
    smallName: String(item.indsSclsNm || "").trim(),
    adminDong: String(item.adongNm || "").trim(),
    legalDong: String(item.ldongNm || "").trim(),
    address: String(item.rdnmAdr || item.lnoAdr || "").trim(),
    lotAddress: String(item.lnoAdr || "").trim(),
    pnu: String(item.lnoCd || ""),
    legacyPnu: toLegacyPnu(item.lnoCd),
    buildingNo: String(item.bldMngNo || ""),
    buildingName: String(item.bldNm || "").trim(),
    floor: String(item.flrNo || "").trim(),
    longitude: Number(item.lon),
    latitude: Number(item.lat)
  };
}

export function filterStores(stores, filters = {}) {
  const query = String(filters.query || "").trim().toLocaleLowerCase("ko");
  const storeName = String(filters.storeName || "").trim().toLocaleLowerCase("ko");
  return stores.filter((store) => {
    if (filters.adminDong && store.adminDong !== filters.adminDong) return false;
    if (filters.largeCode && store.largeCode !== filters.largeCode) return false;
    if (filters.middleCode && store.middleCode !== filters.middleCode) return false;
    if (filters.smallCode && store.smallCode !== filters.smallCode) return false;
    if (filters.zoneGeometry && !pointInGeometry(store.longitude, store.latitude, filters.zoneGeometry)) return false;
    if (storeName && ![store.name, store.branch]
      .some((value) => String(value || "").toLocaleLowerCase("ko").includes(storeName))) return false;
    if (!query) return true;
    return [store.name, store.branch, store.address, store.lotAddress, store.buildingName]
      .some((value) => String(value || "").toLocaleLowerCase("ko").includes(query));
  });
}

export function sortStores(stores, sortKey = "name-asc") {
  const [field, order] = ["name-asc", "name-desc", "industry-asc", "industry-desc"].includes(sortKey)
    ? sortKey.split("-")
    : ["name", "asc"];
  const direction = order === "desc" ? -1 : 1;
  return [...stores].sort((left, right) => {
    const primaryField = field === "industry" ? "largeName" : "name";
    const primary = String(left[primaryField] || "").localeCompare(String(right[primaryField] || ""), "ko");
    if (primary) return primary * direction;
    const name = String(left.name || "").localeCompare(String(right.name || ""), "ko");
    if (name) return field === "name" ? name * direction : name;
    return String(left.branch || "").localeCompare(String(right.branch || ""), "ko");
  });
}

export function buildLocationFilter(adminDong, zoneGeometry) {
  if (zoneGeometry) return { zoneGeometry };
  return adminDong ? { adminDong } : {};
}

export function buildLocationSelection(kind, value) {
  const selected = String(value || "");
  if (kind === "zone") return { adminDong: "", zoneNo: selected };
  if (kind === "dong") return { adminDong: selected, zoneNo: "" };
  throw new Error(`지원하지 않는 지역 선택 유형입니다: ${kind}`);
}

function pointOnSegment(longitude, latitude, start, end) {
  const cross = (longitude - start[0]) * (end[1] - start[1]) - (latitude - start[1]) * (end[0] - start[0]);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (longitude - start[0]) * (longitude - end[0]) + (latitude - start[1]) * (latitude - end[1]);
  return dot <= 1e-12;
}

function classifyPointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if (pointOnSegment(longitude, latitude, ring[index], ring[previous])) return { inside: true, boundary: true };
    const crosses = (y1 > latitude) !== (y2 > latitude)
      && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1;
    if (crosses) inside = !inside;
  }
  return { inside, boundary: false };
}

export function pointInGeometry(longitude, latitude, geometry) {
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return false;
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  return polygons.some((polygon) => {
    if (!polygon[0]) return false;
    const exterior = classifyPointInRing(longitude, latitude, polygon[0]);
    if (!exterior.inside) return false;
    return !polygon.slice(1).some((hole) => {
      const classification = classifyPointInRing(longitude, latitude, hole);
      return classification.inside && !classification.boundary;
    });
  });
}

export function geometryAreaSqm(geometry) {
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return 0;
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  return polygons.reduce((total, polygon) => total + polygon.reduce((polygonArea, ring, ringIndex) => {
    if (ring.length < 4) return polygonArea;
    const meanLatitude = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
    const lonScale = 111320 * Math.cos(meanLatitude * Math.PI / 180);
    const latScale = 110540;
    let twiceArea = 0;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
      const previousX = ring[previous][0] * lonScale;
      const previousY = ring[previous][1] * latScale;
      const currentX = ring[index][0] * lonScale;
      const currentY = ring[index][1] * latScale;
      twiceArea += previousX * currentY - currentX * previousY;
    }
    const area = Math.abs(twiceArea) / 2;
    return polygonArea + (ringIndex === 0 ? area : -area);
  }, 0), 0);
}

export function countBy(items, key) {
  return [...items.reduce((counts, item) => {
    const value = typeof key === "function" ? key(item) : item[key];
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map())]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
}

export function summarizeStores(stores) {
  return {
    total: stores.length,
    dongCount: new Set(stores.map((store) => store.adminDong).filter(Boolean)).size,
    topLarge: countBy(stores, "largeName")[0] || null,
    largeCategories: countBy(stores, "largeName"),
    smallCategories: countBy(stores, "smallName")
  };
}
