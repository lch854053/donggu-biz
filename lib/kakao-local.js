const KAKAO_COORD2ADDRESS_URL = "https://dapi.kakao.com/v2/local/geo/coord2address.json";
const KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAUSE_MS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value) {
  return String(value ?? "").trim();
}

function coordinateKey(store) {
  return `${store.longitude},${store.latitude}`;
}

function hasCoordinates(store) {
  return Number.isFinite(store?.longitude) && Number.isFinite(store?.latitude);
}

function normalizePlaceName(value) {
  return clean(value)
    .normalize("NFKC")
    .replace(/주식회사|\(주\)|㈜/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLocaleLowerCase("ko");
}

function namesEquivalent(left, right) {
  const a = normalizePlaceName(left);
  const b = normalizePlaceName(right);
  return Boolean(a && b && (a === b || (a.length >= 4 && (a.includes(b) || b.includes(a)))));
}

function distanceMeters(left, top, right, bottom) {
  const lat1 = top * Math.PI / 180;
  const lat2 = bottom * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (right - left) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
}

export function isMaskedAddress(value) {
  return /[*＊]/.test(clean(value));
}

export function buildCoordinateAddressUrl(longitude, latitude) {
  const url = new URL(KAKAO_COORD2ADDRESS_URL);
  url.search = new URLSearchParams({
    x: String(longitude),
    y: String(latitude),
    input_coord: "WGS84"
  }).toString();
  return url;
}

export function buildKeywordSearchUrl(name, longitude, latitude, radius = 200) {
  const url = new URL(KAKAO_KEYWORD_URL);
  url.search = new URLSearchParams({
    query: String(name),
    x: String(longitude),
    y: String(latitude),
    radius: String(radius),
    sort: "distance",
    size: "15"
  }).toString();
  return url;
}

export function parseCoordinateAddressResponse(payload) {
  const document = Array.isArray(payload?.documents) ? payload.documents[0] : null;
  if (!document) return null;

  const roadAddress = clean(document.road_address?.address_name);
  const lotAddress = clean(document.address?.address_name);
  if (!roadAddress && !lotAddress) return null;

  return {
    address: roadAddress || lotAddress,
    lotAddress,
    buildingName: clean(document.road_address?.building_name),
    postalCode: clean(document.road_address?.zone_no)
  };
}

export function parseKeywordSearchResponse(payload, name, longitude, latitude, maxDistance = 200) {
  const places = Array.isArray(payload?.documents) ? payload.documents : [];
  const candidates = places
    .filter((place) => namesEquivalent(name, place?.place_name))
    .map((place) => {
      const placeLongitude = Number(place.x);
      const placeLatitude = Number(place.y);
      if (!Number.isFinite(placeLongitude) || !Number.isFinite(placeLatitude)) return null;
      const reportedDistance = clean(place.distance) ? Number(place.distance) : NaN;
      const distance = Number.isFinite(reportedDistance)
        ? reportedDistance
        : distanceMeters(longitude, latitude, placeLongitude, placeLatitude);
      if (distance > maxDistance) return null;
      const roadAddress = clean(place.road_address_name);
      const lotAddress = clean(place.address_name);
      if (!roadAddress && !lotAddress) return null;
      return {
        address: roadAddress || lotAddress,
        lotAddress,
        buildingName: "",
        postalCode: "",
        source: "Kakao Local 장소 검색",
        distanceMeters: distance,
        placeId: clean(place.id)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
  return candidates[0] || null;
}

async function fetchJson(
  url,
  apiKey,
  {
    fetchImpl = globalThis.fetch,
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleepImpl = sleep
  } = {}
) {
  if (!apiKey) throw new Error("KAKAO_REST_API_KEY 환경변수가 필요합니다.");
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `KakaoAK ${apiKey}`
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`카카오 Local API 오류 HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        error.detail = payload?.message || payload?.error_description || "";
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === maxRetries) throw error;
      await sleepImpl(attempt * 1000);
    }
  }

  throw lastError;
}

export async function fetchCoordinateAddress(longitude, latitude, apiKey, options = {}) {
  const payload = await fetchJson(buildCoordinateAddressUrl(longitude, latitude), apiKey, options);
  return parseCoordinateAddressResponse(payload);
}

export async function fetchKeywordPlaceAddress(name, longitude, latitude, apiKey, options = {}) {
  const maxDistance = options.maxDistance ?? 200;
  const payload = await fetchJson(buildKeywordSearchUrl(name, longitude, latitude, maxDistance), apiKey, options);
  return parseKeywordSearchResponse(payload, name, longitude, latitude, maxDistance);
}

function enrichStore(store, address) {
  return {
    ...store,
    sourceAddress: store.sourceAddress || store.address || "",
    sourceLotAddress: store.sourceLotAddress || store.lotAddress || "",
    address: address.address || store.address,
    lotAddress: address.lotAddress || store.lotAddress,
    buildingName: store.buildingName || address.buildingName,
    postalCode: address.postalCode || store.postalCode || "",
    addressSource: address.source || "Kakao Local 좌표→주소"
  };
}

export async function enrichStoreAddresses(
  stores,
  {
    apiKey,
    fetchImpl = globalThis.fetch,
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pauseMs = DEFAULT_PAUSE_MS,
    sleepImpl = sleep,
    onError = () => {}
  } = {}
) {
  const rows = Array.isArray(stores) ? stores : [];
  const candidates = rows.filter((store) => hasCoordinates(store)
    && (isMaskedAddress(store.address) || isMaskedAddress(store.lotAddress)));
  const uniqueCoordinates = new Set(candidates.map(coordinateKey));
  const coordinateCache = new Map();
  const keywordCache = new Map();
  const stats = {
    candidateCount: candidates.length,
    uniqueCoordinateCount: uniqueCoordinates.size,
    requestCount: 0,
    keywordRequestCount: 0,
    keywordFallbackCount: 0,
    enrichedCount: 0,
    failedCount: 0,
    unresolvedCount: 0,
    skippedCount: 0
  };

  if (!apiKey) {
    stats.skippedCount = candidates.length;
    return { stores: rows, stats };
  }

  for (const store of candidates) {
    const key = coordinateKey(store);
    if (!coordinateCache.has(key)) {
      try {
        const address = await fetchCoordinateAddress(store.longitude, store.latitude, apiKey, {
          fetchImpl,
          maxRetries,
          timeoutMs,
          sleepImpl
        });
        coordinateCache.set(key, address);
        stats.requestCount += 1;
      } catch (error) {
        coordinateCache.set(key, null);
        stats.requestCount += 1;
        stats.failedCount += 1;
        onError(error, store);
      }
      if (pauseMs > 0) await sleepImpl(pauseMs);
    }
  }

  for (const store of candidates) {
    const coordinate = coordinateKey(store);
    if (coordinateCache.get(coordinate) || !clean(store.name)) continue;
    const key = `${coordinate}|${normalizePlaceName(store.name)}`;
    if (keywordCache.has(key)) continue;
    try {
      const address = await fetchKeywordPlaceAddress(
        store.name,
        store.longitude,
        store.latitude,
        apiKey,
        { fetchImpl, maxRetries, timeoutMs, sleepImpl }
      );
      keywordCache.set(key, address);
      stats.keywordRequestCount += 1;
      if (address) stats.keywordFallbackCount += 1;
    } catch (error) {
      keywordCache.set(key, null);
      stats.keywordRequestCount += 1;
      stats.failedCount += 1;
      onError(error, store);
    }
    if (pauseMs > 0) await sleepImpl(pauseMs);
  }

  const enrichedStores = rows.map((store) => {
    if (!hasCoordinates(store) || (!isMaskedAddress(store.address) && !isMaskedAddress(store.lotAddress))) {
      return store;
    }
    const coordinate = coordinateKey(store);
    const address = coordinateCache.get(coordinate)
      || keywordCache.get(`${coordinate}|${normalizePlaceName(store.name)}`);
    if (!address) {
      stats.unresolvedCount += 1;
      return store;
    }
    stats.enrichedCount += 1;
    return enrichStore(store, address);
  });

  return { stores: enrichedStores, stats };
}
