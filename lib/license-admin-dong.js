import { adminDongForAddress, normalizeAdminDongName } from "./admin-dong.js";
import { distanceMeters } from "./store-license.js";

const LEGAL_DONG_MATCH_METERS = 250;
const NEAREST_STORE_MATCH_METERS = 120;

function legalDongNames(address) {
  return [...new Set(String(address || "").match(/[가-힣]+동/g) || [])];
}

// 인허가 행에는 행정동이 없어 주소 표기 → 확정 주소록 → 같은 법정동 최근접 점포 순으로만 채우고,
// 어느 쪽으로도 확정되지 않으면 추정하지 않고 빈 값으로 남긴다.
export function createLicenseAdminDongResolver(baseStores, addressLookup = new Map()) {
  const stores = baseStores || [];
  const storesByLegalDong = new Map();
  for (const store of stores) {
    if (!store.legalDong || !store.adminDong) continue;
    if (!storesByLegalDong.has(store.legalDong)) storesByLegalDong.set(store.legalDong, []);
    storesByLegalDong.get(store.legalDong).push(store);
  }
  const located = stores.filter((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude));

  return (address, coordinates) => {
    const explicit = normalizeAdminDongName(String(address || "").replace(/[(),]/g, " "));
    if (explicit) return explicit;
    const known = adminDongForAddress(address, addressLookup);
    if (known) return known;

    const legalStores = legalDongNames(address).flatMap((name) => storesByLegalDong.get(name) || []);
    const nearestLegalStore = legalStores
      .filter((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude))
      .map((store) => ({ store, distance: distanceMeters(coordinates, store) }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearestLegalStore && nearestLegalStore.distance <= LEGAL_DONG_MATCH_METERS) return nearestLegalStore.store.adminDong;

    const nearestStore = located
      .map((store) => ({ store, distance: distanceMeters(coordinates, store) }))
      .sort((left, right) => left.distance - right.distance)[0];
    return nearestStore && nearestStore.distance <= NEAREST_STORE_MATCH_METERS ? nearestStore.store.adminDong : "";
  };
}
