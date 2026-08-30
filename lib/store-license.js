import proj4 from "proj4";
import { normalizeAddressLookupKey, normalizeAdminDongName } from "./admin-dong.js";

const EPSG_5174 = "+proj=tmerc +lat_0=38 +lon_0=127.002890277778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-145.907,505.034,685.756,-1.162,2.347,1.592,6.342 +units=m +no_defs +type=crs";
const WGS84 = "EPSG:4326";
const EARTH_RADIUS_METERS = 6_371_000;

export const LOCALDATA_ADMIN_CODE = "5805000";
export const LOCALDATA_PAGE_SIZE = 100;

export const LOCALDATA_SOURCES = Object.freeze([
  {
    slug: "general_restaurants",
    datasetId: "15154916",
    title: "행정안전부_식품_일반음식점 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/general_restaurants/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "rest_cafes",
    datasetId: "15154921",
    title: "행정안전부_식품_휴게음식점 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/rest_cafes/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "bakeries",
    datasetId: "15155252",
    title: "행정안전부_식품_제과점영업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/bakeries/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "beauty_salons",
    datasetId: "15154918",
    title: "행정안전부_생활_미용업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/beauty_salons/info",
    largeCode: "S2",
    largeName: "수리·개인",
    middleCode: "S207",
    middleName: "이용·미용"
  },
  {
    slug: "barber_shops",
    datasetId: "15154922",
    title: "행정안전부_생활_이용업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/barber_shops/info",
    largeCode: "S2",
    largeName: "수리·개인",
    middleCode: "S207",
    middleName: "이용·미용"
  },
  {
    slug: "tobacco_retailers",
    datasetId: "15155031",
    title: "행정안전부_기타_담배소매업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/tobacco_retailers/info",
    largeCode: "G2",
    largeName: "소매",
    middleCode: "G204",
    middleName: "종합 소매"
  },
  {
    slug: "lodgings",
    datasetId: "15155124",
    title: "행정안전부_문화_숙박업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/lodgings/info",
    largeCode: "I1",
    largeName: "숙박",
    middleCode: "I101",
    middleName: "일반 숙박"
  },
  {
    slug: "karaoke_rooms",
    datasetId: "15155135",
    title: "행정안전부_문화_노래연습장업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/karaoke_rooms/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "R104",
    middleName: "유원지·오락"
  },
  {
    slug: "pharmacies",
    datasetId: "15154822",
    title: "행정안전부_건강_약국 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/pharmacies/info",
    largeCode: "Q1",
    largeName: "보건의료",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "clinics",
    datasetId: "15154874",
    title: "행정안전부_건강_의원 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/clinics/info",
    largeCode: "Q1",
    largeName: "보건의료",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "hospitals",
    datasetId: "15154458",
    title: "행정안전부_건강_병원 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/hospitals/info",
    largeCode: "Q1",
    largeName: "보건의료",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "optical_shops",
    datasetId: "15154899",
    title: "행정안전부_건강_안경업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/optical_shops/info",
    largeCode: "G2",
    largeName: "소매",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "animal_hospitals",
    datasetId: "15154952",
    title: "행정안전부_동물_동물병원 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/animal_hospitals/info",
    largeCode: "Q1",
    largeName: "보건의료",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "animal_pharmacies",
    datasetId: "15155272",
    title: "행정안전부_동물_동물약국 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/animal_pharmacies/info",
    largeCode: "G2",
    largeName: "소매",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "pet_grooming",
    datasetId: "15154944",
    title: "행정안전부_동물_동물미용업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/pet_grooming/info",
    largeCode: "S2",
    largeName: "수리·개인",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "animal_sales",
    datasetId: "15155083",
    title: "행정안전부_동물_동물판매업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/animal_sales/info",
    largeCode: "G2",
    largeName: "소매",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "animal_boarding",
    datasetId: "15155055",
    title: "행정안전부_동물_동물위탁관리업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/animal_boarding/info",
    largeCode: "S2",
    largeName: "수리·개인",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "fitness_centers",
    datasetId: "15155077",
    title: "행정안전부_생활_체력단련장업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/fitness_centers/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "martial_arts_dojo",
    datasetId: "15155085",
    title: "행정안전부_생활_체육도장업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/martial_arts_dojo/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "golf_practice_ranges",
    datasetId: "15154975",
    title: "행정안전부_생활_골프연습장업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/golf_practice_ranges/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "billiard_halls",
    datasetId: "15155011",
    title: "행정안전부_생활_당구장업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/billiard_halls/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "swimming_pools",
    datasetId: "15155038",
    title: "행정안전부_생활_수영장업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/swimming_pools/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "comprehensive_sports_facilities",
    datasetId: "15155071",
    title: "행정안전부_생활_종합체육시설업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/comprehensive_sports_facilities/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "public_baths",
    datasetId: "15155091",
    title: "행정안전부_생활_목욕장업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/public_baths/info",
    largeCode: "S2",
    largeName: "수리·개인",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "laundries",
    datasetId: "15154927",
    title: "행정안전부_생활_세탁업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/laundries/info",
    largeCode: "S2",
    largeName: "수리·개인",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "pc_bangs",
    datasetId: "15154951",
    title: "행정안전부_문화_인터넷컴퓨터게임시설제공업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/pc_bangs/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "general_game_providers",
    datasetId: "15154955",
    title: "행정안전부_문화_일반게임제공업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/general_game_providers/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "youth_game_providers",
    datasetId: "15154958",
    title: "행정안전부_문화_청소년게임제공업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/youth_game_providers/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "mixed_game_providers",
    datasetId: "15154945",
    title: "행정안전부_문화_복합유통게임제공업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/mixed_game_providers/info",
    largeCode: "R1",
    largeName: "예술·스포츠",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "entertainment_bars",
    datasetId: "15154890",
    title: "행정안전부_식품_유흥주점영업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/entertainment_bars/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "singing_bars",
    datasetId: "15154883",
    title: "행정안전부_식품_단란주점영업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/singing_bars/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "instant_food_processors",
    datasetId: "15155245",
    title: "행정안전부_식품_즉석판매제조가공업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/instant_food_processors/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "food_vending_machines",
    datasetId: "15155144",
    title: "행정안전부_식품_식품자동판매기업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/food_vending_machines/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "food_repackagers",
    datasetId: "15155126",
    title: "행정안전부_식품_식품소분업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/food_repackagers/info",
    largeCode: "I2",
    largeName: "음식",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "other_food_retailers",
    datasetId: "15155170",
    title: "행정안전부_식품_식품판매업(기타) 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/other_food_retailers/info",
    largeCode: "G2",
    largeName: "소매",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "health_functional_food_general_retailers",
    datasetId: "15155221",
    title: "행정안전부_식품_건강기능식품일반판매업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/health_functional_food_general_retailers/info",
    largeCode: "G2",
    largeName: "소매",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "tourist_accommodations",
    datasetId: "15155090",
    title: "행정안전부_문화_관광숙박업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/tourist_accommodations/info",
    largeCode: "I1",
    largeName: "숙박",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "rural_homestays",
    datasetId: "15155113",
    title: "행정안전부_문화_농어촌민박업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/rural_homestays/info",
    largeCode: "I1",
    largeName: "숙박",
    middleCode: "",
    middleName: ""
  },
  {
    slug: "tourist_pensions",
    datasetId: "15155103",
    title: "행정안전부_문화_관광펜션업 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/tourist_pensions/info",
    largeCode: "I1",
    largeName: "숙박",
    middleCode: "",
    middleName: ""
  }
]);

function clean(value) {
  return String(value ?? "").trim();
}

function dateDigits(value) {
  return clean(value).replace(/[^0-9]/g, "");
}

function normalizeMatchText(value) {
  return clean(value)
    .normalize("NFKC")
    .replace(/전남광주통합특별시|광주광역시|광주시|광주/g, "")
    .replace(/주식회사|\(주\)|㈜/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLocaleLowerCase("ko");
}

export function normalizeStoreName(value) {
  return normalizeMatchText(value);
}

export function normalizeStoreAddress(value) {
  return normalizeMatchText(normalizeAddressLookupKey(value));
}

export function namesEquivalent(left, right) {
  const a = normalizeStoreName(left);
  const b = normalizeStoreName(right);
  return Boolean(a && b && (a === b || (a.length >= 4 && (a.includes(b) || b.includes(a)))));
}

export function epsg5174ToWgs84(x, y) {
  if (!clean(x) || !clean(y)) return null;
  const easting = Number(x);
  const northing = Number(y);
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  const [longitude, latitude] = proj4(EPSG_5174, WGS84, [easting, northing]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < 120 || longitude > 140 || latitude < 30 || latitude > 45) return null;
  return { longitude, latitude };
}

export function distanceMeters(left, right) {
  if (!Number.isFinite(left?.longitude) || !Number.isFinite(left?.latitude)
    || !Number.isFinite(right?.longitude) || !Number.isFinite(right?.latitude)) return Infinity;
  const lat1 = left.latitude * Math.PI / 180;
  const lat2 = right.latitude * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (right.longitude - left.longitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

export function parseLocaldataResponse(payload) {
  const response = payload?.response;
  const header = response?.header || {};
  const body = response?.body || {};
  const resultCode = clean(header.resultCode);
  if (resultCode !== "0") throw new Error(`${resultCode || "UNKNOWN"}: ${clean(header.resultMsg) || "인허가 API 오류"}`);
  const rawItems = body.items?.item || [];
  return {
    totalCount: Number(body.totalCount || 0),
    pageNo: Number(body.pageNo || 0),
    numOfRows: Number(body.numOfRows || 0),
    items: Array.isArray(rawItems) ? rawItems : [rawItems]
  };
}

function licenseType(source, item) {
  if (source.slug === "beauty_salons") return clean(item.BZSTAT_SE_NM) || clean(item.SNTTN_BZSTAT_NM) || "미용업";
  if (source.slug === "barber_shops") return clean(item.BZSTAT_SE_NM) || "이용업";
  if (source.slug === "tobacco_retailers") return clean(item.CVLCPT_KND_NM) || "담배소매업";
  if (source.slug === "lodgings" || source.slug === "karaoke_rooms") return clean(item.BZSTAT_SE_NM) || source.title.split("_").at(-1).replace(" 조회서비스", "");
  return clean(item.BZSTAT_SE_NM) || source.title.split("_").at(-1).replace(" 조회서비스", "");
}

function licenseSmallName(source, item) {
  const type = licenseType(source, item);
  if (source.slug === "beauty_salons" && /피부/.test(`${type} ${clean(item.SNTTN_BZSTAT_NM)}`)) return "피부 관리실";
  if (source.slug === "beauty_salons" && /네일/.test(`${type} ${clean(item.SNTTN_BZSTAT_NM)}`)) return "네일아트";
  if (source.slug === "beauty_salons") return "미용실";
  if (source.slug === "barber_shops") return "이용업";
  if (source.slug === "tobacco_retailers") return "담배소매업";
  if (source.slug === "lodgings") return "숙박업";
  if (source.slug === "karaoke_rooms") return "노래방";
  return type;
}

export function isActiveLicense(item) {
  const code = clean(item.SALS_STTS_CD);
  if (code) return code === "01";
  const name = clean(item.SALS_STTS_NM);
  return Boolean(name) && /영업|정상/.test(name) && !/휴업|폐업|취소|말소/.test(name);
}

export function compactLicense(item, source, { adminDong = "" } = {}) {
  const managementNo = clean(item.MNG_NO);
  const name = clean(item.BPLC_NM);
  const address = clean(item.ROAD_NM_ADDR) || clean(item.LOTNO_ADDR);
  const coordinates = epsg5174ToWgs84(item.CRD_INFO_X, item.CRD_INFO_Y);
  const fallbackId = `${normalizeStoreName(name)}:${normalizeStoreAddress(address)}`;
  return {
    id: `license:${source.slug}:${managementNo || fallbackId}`,
    source: "행정안전부 지방행정 인허가 데이터",
    sourceSlug: source.slug,
    sourceDatasetId: source.datasetId,
    sourceName: source.title,
    licenseId: managementNo,
    sourceAdminCode: clean(item.OPN_ATMY_GRP_CD),
    name,
    branch: "",
    largeCode: source.largeCode,
    largeName: source.largeName,
    middleCode: source.middleCode,
    middleName: source.middleName,
    smallCode: "",
    smallName: licenseSmallName(source, item),
    adminDong: adminDong || normalizeAdminDongName(address.replace(/[(),]/g, " ")),
    legalDong: "",
    address,
    lotAddress: clean(item.LOTNO_ADDR),
    pnu: "",
    legacyPnu: "",
    buildingNo: "",
    buildingName: "",
    floor: "",
    longitude: coordinates?.longitude ?? null,
    latitude: coordinates?.latitude ?? null,
    licenseType: licenseType(source, item),
    statusCode: clean(item.SALS_STTS_CD),
    statusName: clean(item.SALS_STTS_NM),
    detailStatusName: clean(item.DTL_SALS_STTS_NM),
    licenseDate: clean(item.LCPMT_YMD),
    closedDate: clean(item.CLSBIZ_YMD),
    lastModifiedAt: clean(item.LAST_MDFCN_PNT || item.DAT_UPDT_PNT)
  };
}

function sameAddress(left, right) {
  const leftRoad = normalizeStoreAddress(left.address);
  const rightRoad = normalizeStoreAddress(right.address);
  const leftLot = normalizeStoreAddress(left.lotAddress);
  const rightLot = normalizeStoreAddress(right.lotAddress);
  return Boolean((leftRoad && rightRoad && leftRoad === rightRoad)
    || (leftLot && rightLot && leftLot === rightLot));
}

function addressNameKey(store) {
  const name = normalizeStoreName(store.name);
  const address = normalizeStoreAddress(store.address) || normalizeStoreAddress(store.lotAddress);
  return name && address ? `${name}|${address}` : "";
}

export function deduplicateLicenseStores(stores) {
  const unique = [];
  const byKey = new Map();
  for (const store of stores || []) {
    if (!store?.name) continue;
    const key = addressNameKey(store);
    const existingIndex = key ? byKey.get(key) : undefined;
    if (existingIndex !== undefined) {
      unique[existingIndex] = mergeLicenseStore(unique[existingIndex], store);
      continue;
    }
    const nearbyIndex = unique.findIndex((candidate) => namesEquivalent(candidate.name, store.name)
      && sameAddress(candidate, store));
    if (nearbyIndex >= 0) {
      unique[nearbyIndex] = mergeLicenseStore(unique[nearbyIndex], store);
      if (key) byKey.set(key, nearbyIndex);
      continue;
    }
    const index = unique.push(store) - 1;
    if (key) byKey.set(key, index);
  }
  return unique;
}

function mergeLicenseStore(left, right) {
  return {
    ...left,
    sourceSlugs: [...new Set([...(left.sourceSlugs || [left.sourceSlug]), ...(right.sourceSlugs || [right.sourceSlug])])].filter(Boolean),
    licenseIds: [...new Set([...(left.licenseIds || [left.licenseId]), ...(right.licenseIds || [right.licenseId])])].filter(Boolean),
    sourceDatasetIds: [...new Set([...(left.sourceDatasetIds || [left.sourceDatasetId]), ...(right.sourceDatasetIds || [right.sourceDatasetId])])].filter(Boolean)
  };
}

function buildStoreIndex(stores) {
  const byName = new Map();
  const byAddress = new Map();
  for (const store of stores || []) {
    const name = normalizeStoreName(store.name);
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(store);
    }
    for (const address of [store.address, store.lotAddress]) {
      const normalized = normalizeStoreAddress(address);
      if (normalized) {
        if (!byAddress.has(normalized)) byAddress.set(normalized, []);
        byAddress.get(normalized).push(store);
      }
    }
  }
  return { byName, byAddress };
}

function findLicenseMatch(license, index) {
  const name = normalizeStoreName(license.name);
  const addressKeys = [license.address, license.lotAddress]
    .map(normalizeStoreAddress)
    .filter(Boolean);
  const addressCandidates = [...new Set(addressKeys.flatMap((key) => index.byAddress.get(key) || []))];
  const exactAddress = addressCandidates.find((store) => namesEquivalent(license.name, store.name));
  if (exactAddress) return { store: exactAddress, type: "name-address", distanceMeters: distanceMeters(license, exactAddress) };

  const sameCategory = addressCandidates.filter((store) => store.largeCode === license.largeCode);
  if (sameCategory.length === 1) {
    return { store: sameCategory[0], type: "category-address", distanceMeters: distanceMeters(license, sameCategory[0]) };
  }

  const nameCandidates = index.byName.get(name) || [];
  const exactName = nameCandidates.find((store) => sameAddress(license, store));
  if (exactName) return { store: exactName, type: "name-address", distanceMeters: distanceMeters(license, exactName) };

  const nearbyName = nameCandidates
    .map((store) => ({ store, distanceMeters: distanceMeters(license, store) }))
    .sort((left, right) => left.distanceMeters - right.distanceMeters)[0];
  if (nearbyName && nearbyName.distanceMeters <= 30) return { ...nearbyName, type: "name-coordinate" };

  const nearbyAddress = addressCandidates
    .map((store) => ({ store, distanceMeters: distanceMeters(license, store) }))
    .sort((left, right) => left.distanceMeters - right.distanceMeters)[0];
  if (nearbyAddress && nearbyAddress.distanceMeters <= 20 && namesEquivalent(license.name, nearbyAddress.store.name)) {
    return { ...nearbyAddress, type: "name-address" };
  }
  return null;
}

export function compareStoreSources(baseStores, licenseStores) {
  const uniqueLicenses = deduplicateLicenseStores(licenseStores);
  const index = buildStoreIndex(baseStores);
  const matched = [];
  const unmatched = [];
  for (const license of uniqueLicenses) {
    const match = findLicenseMatch(license, index);
    if (match) matched.push({ license, ...match });
    else unmatched.push(license);
  }
  const bySource = new Map();
  const sourceRow = (sourceSlug) => {
    const row = bySource.get(sourceSlug) || { sourceSlug, raw: 0, unique: 0, matched: 0, added: 0 };
    bySource.set(sourceSlug, row);
    return row;
  };
  for (const license of licenseStores || []) {
    for (const sourceSlug of license.sourceSlugs || [license.sourceSlug]) sourceRow(sourceSlug).raw += 1;
  }
  for (const license of uniqueLicenses) {
    for (const sourceSlug of license.sourceSlugs || [license.sourceSlug]) sourceRow(sourceSlug).unique += 1;
  }
  for (const { license } of matched) {
    for (const sourceSlug of license.sourceSlugs || [license.sourceSlug]) sourceRow(sourceSlug).matched += 1;
  }
  for (const license of unmatched) {
    for (const sourceSlug of license.sourceSlugs || [license.sourceSlug]) sourceRow(sourceSlug).added += 1;
  }
  return {
    rawLicenseCount: (licenseStores || []).length,
    uniqueLicenseCount: uniqueLicenses.length,
    matchedCount: matched.length,
    addedCount: unmatched.length,
    addedWithCoordinatesCount: unmatched.filter((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude)).length,
    addedWithoutCoordinatesCount: unmatched.filter((store) => !Number.isFinite(store.longitude) || !Number.isFinite(store.latitude)).length,
    matchTypeCounts: matched.reduce((counts, row) => ({ ...counts, [row.type]: (counts[row.type] || 0) + 1 }), {}),
    bySource: [...bySource.values()],
    matched,
    unmatched
  };
}

export function mergeStoreSources(baseStores, licenseStores) {
  const comparison = compareStoreSources(baseStores, licenseStores);
  const added = comparison.unmatched.filter((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude));
  return {
    stores: [...baseStores, ...added],
    added,
    comparison
  };
}

export function latestSourceTimestamp(items) {
  return (items || [])
    .map((item) => clean(item.lastModifiedAt))
    .filter(Boolean)
    .sort((left, right) => dateDigits(right).localeCompare(dateDigits(left)))[0] || "";
}
