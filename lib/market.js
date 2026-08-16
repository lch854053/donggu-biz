const EARTH_RADIUS_M = 6371008.8;

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

export function distanceMeters(a, b) {
  const toRad = (value) => value * Math.PI / 180;
  const lat1 = toRad(Number(a.latitude));
  const lat2 = toRad(Number(b.latitude));
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(b.longitude) - Number(a.longitude));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function filterStores(stores, filters = {}) {
  const query = String(filters.query || "").trim().toLocaleLowerCase("ko");
  return stores.filter((store) => {
    if (filters.adminDong && store.adminDong !== filters.adminDong) return false;
    if (filters.largeCode && store.largeCode !== filters.largeCode) return false;
    if (filters.middleCode && store.middleCode !== filters.middleCode) return false;
    if (filters.smallCode && store.smallCode !== filters.smallCode) return false;
    if (!query) return true;
    return [store.name, store.branch, store.address, store.lotAddress, store.buildingName]
      .some((value) => String(value || "").toLocaleLowerCase("ko").includes(query));
  });
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

export function storesInRadius(stores, center, radius) {
  return stores
    .map((store) => ({ store, distance: distanceMeters(center, store) }))
    .filter((entry) => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}
