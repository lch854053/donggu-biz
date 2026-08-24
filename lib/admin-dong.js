export const DONGGU_ADMIN_DONGS = Object.freeze([
  "충장동", "동명동", "계림1동", "계림2동", "산수1동", "산수2동", "지산1동",
  "지산2동", "서남동", "학동", "학운동", "지원1동", "지원2동"
]);

export function normalizeAddressLookupKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[（(][^()（）]*[)）]/g, " ")
    .replace(/^(?:전남광주통합특별시|광주광역시|광주시|광주)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAdminDongName(value) {
  const tokens = String(value ?? "").trim().split(/\s+/);
  return DONGGU_ADMIN_DONGS.find((name) => tokens.includes(name)) || "";
}

export function createAdminDongLookup(payload) {
  return new Map((payload?.items || [])
    .map((item) => [normalizeAddressLookupKey(item?.address), normalizeAdminDongName(item?.adminDong)])
    .filter(([address, adminDong]) => address && adminDong));
}

export function adminDongForAddress(address, lookup) {
  return lookup.get(normalizeAddressLookupKey(address)) || "";
}
