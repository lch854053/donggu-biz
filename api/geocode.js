// 카카오 주소 검색 프록시. 클라이언트에 카카오 REST API 키를 노출하지 않기 위해
// 서버 함수에서만 호출한다. GET /api/geocode?q=도로명+주소
const KAKAO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json";

export const maxDuration = 15;

function pickDocument(documents) {
  // 도로명 주소 결과를 우선하고, 없으면 지번 주소를 쓴다.
  return documents.find((doc) => doc.road_address) || documents[0] || null;
}

export default async function handler(req, res) {
  const query = String(req.query?.q ?? "").trim();
  if (!query) {
    return res.status(400).json({ error: "q 파라미터에 주소를 넣어주세요." });
  }

  const apiKey = process.env.KAKAO_REST_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "지오코딩 키가 설정되지 않았습니다." });
  }

  try {
    const response = await fetch(`${KAKAO_ADDRESS_URL}?${new URLSearchParams({ query, analyze_type: "similar" })}`, {
      headers: { Authorization: `KakaoAK ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 429) {
      return res.status(429).json({ error: "지오코딩 요청이 많습니다. 잠시 후 다시 시도하세요." });
    }
    if (!response.ok) {
      return res.status(502).json({ error: `주소 검색에 실패했습니다. HTTP ${response.status}` });
    }
    const payload = await response.json();
    const doc = pickDocument(payload?.documents || []);
    if (!doc) {
      return res.status(404).json({ error: "주소를 찾지 못했습니다." });
    }
    const source = doc.road_address ? doc.road_address.address_name : doc.address?.address_name || "";
    const longitude = Number(doc.road_address?.x ?? doc.address?.x);
    const latitude = Number(doc.road_address?.y ?? doc.address?.y);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return res.status(404).json({ error: "주소 좌표를 계산하지 못했습니다." });
    }
    return res.status(200).json({
      latitude,
      longitude,
      addressName: source || query,
      matched: doc.road_address ? "road" : "parcel"
    });
  } catch (error) {
    return res.status(502).json({ error: `주소 검색 중 오류가 발생했습니다: ${error.message}` });
  }
}
