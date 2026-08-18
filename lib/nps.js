// 국민연금공단 국민연금 가입 사업장 내역 (NpsBplcInfoInqireServiceV2) 응답 정규화와 통계 집계.
// 이 API는 사업자등록번호를 앞 6자리까지만 제공하고 주소는 건물번호 없이 도로명까지만 제공한다.

export const NPS_STATUS_LABELS = {
  1: "등록",
  2: "탈퇴"
};

export const NPS_STYLE_LABELS = {
  1: "법인사업장",
  2: "개인사업장"
};

// 한국표준산업분류(KSIC-10) 대분류와 중분류 번호 구간.
const KSIC_SECTIONS = [
  { code: "A", name: "농업, 임업 및 어업", from: 1, to: 3 },
  { code: "B", name: "광업", from: 5, to: 8 },
  { code: "C", name: "제조업", from: 10, to: 34 },
  { code: "D", name: "전기·가스·증기 및 공기조절 공급업", from: 35, to: 35 },
  { code: "E", name: "수도·하수 및 폐기물 처리, 원료 재생업", from: 36, to: 39 },
  { code: "F", name: "건설업", from: 41, to: 42 },
  { code: "G", name: "도매 및 소매업", from: 45, to: 47 },
  { code: "H", name: "운수 및 창고업", from: 49, to: 52 },
  { code: "I", name: "숙박 및 음식점업", from: 55, to: 56 },
  { code: "J", name: "정보통신업", from: 58, to: 63 },
  { code: "K", name: "금융 및 보험업", from: 64, to: 66 },
  { code: "L", name: "부동산업", from: 68, to: 68 },
  { code: "M", name: "전문·과학 및 기술 서비스업", from: 70, to: 73 },
  { code: "N", name: "사업시설 관리, 사업 지원 및 임대 서비스업", from: 74, to: 76 },
  { code: "O", name: "공공행정, 국방 및 사회보장 행정", from: 84, to: 84 },
  { code: "P", name: "교육 서비스업", from: 85, to: 85 },
  { code: "Q", name: "보건업 및 사회복지 서비스업", from: 86, to: 87 },
  { code: "R", name: "예술, 스포츠 및 여가관련 서비스업", from: 90, to: 91 },
  { code: "S", name: "협회 및 단체, 수리 및 기타 개인 서비스업", from: 94, to: 96 },
  { code: "T", name: "가구내 고용활동 및 자가소비 생산활동", from: 97, to: 98 },
  { code: "U", name: "국제 및 외국기관", from: 99, to: 99 }
];

const UNKNOWN_SECTION = { code: "", name: "업종 미상" };

/** 입력값에서 숫자만 남긴 뒤 사업자등록번호 앞 6자리를 돌려준다. API가 6자리까지만 지원한다. */
export function toBizNoPrefix(raw) {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  return digits.slice(0, 6);
}

/** 업종코드(KSIC 세세분류)에서 대분류를 판정한다. 구간에 없는 코드는 미상으로 둔다. */
export function ksicSection(industryCode) {
  const division = Number(String(industryCode ?? "").replace(/[^0-9]/g, "").slice(0, 2));
  if (!Number.isInteger(division) || division <= 0) return UNKNOWN_SECTION;
  return KSIC_SECTIONS.find((section) => division >= section.from && division <= section.to) || UNKNOWN_SECTION;
}

/** 건물번호가 없는 일반화 주소에서 집계 단위로 쓸 "시군구 도로명"을 뽑는다. */
export function addressArea(address) {
  const parts = String(address ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "주소 미상";
  const road = parts[parts.length - 1];
  const district = parts.slice(0, -1).reverse().find((part) => /[시군구]$/.test(part));
  return district ? `${district} ${road}` : road;
}

function text(value) {
  return String(value ?? "").trim();
}

function count(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function labelFor(map, code, fallback) {
  return map[Number(code)] || (code ? `${fallback}(${code})` : fallback);
}

/** 사업장 목록 항목을 화면과 통계가 함께 쓰는 형태로 정규화한다. */
export function compactWorkplace(item) {
  const industryCode = text(item?.wkplIntpCd);
  const section = ksicSection(industryCode);
  const address = text(item?.wkplRoadNmDtlAddr);
  return {
    seq: text(item?.seq),
    dataCreatedMonth: text(item?.dataCrtYm),
    name: text(item?.wkplNm),
    bizNoPrefix: toBizNoPrefix(item?.bzowrRgstNo),
    address,
    area: addressArea(address),
    statusCode: text(item?.wkplJnngStcd),
    statusName: labelFor(NPS_STATUS_LABELS, item?.wkplJnngStcd, "상태 미상"),
    styleCode: text(item?.wkplStylDvcd),
    styleName: labelFor(NPS_STYLE_LABELS, item?.wkplStylDvcd, "형태 미상"),
    industryCode,
    sectionCode: section.code,
    sectionName: section.name,
    sidoCode: text(item?.ldongAddrMgplDgCd),
    sgguCode: text(item?.ldongAddrMgplSgguCd),
    emdCode: text(item?.ldongAddrMgplSgguEmdCd)
  };
}

/** 값이 아예 없는 항목과 0을 구분한다. 오퍼레이션마다 제공하는 항목이 다르다. */
function optionalCount(value) {
  return text(value) === "" ? null : count(value);
}

/**
 * 사업장 상세 항목. 업종코드·업종명·등록일·가입자 수·고지금액은 상세조회에만 있고,
 * 월별 취득·상실자 수는 기간별 현황 오퍼레이션에서 합쳐 온다.
 */
export function compactWorkplaceDetail(item) {
  return {
    ...compactWorkplace(item),
    industryName: text(item?.vldtVlKrnNm),
    registeredDate: text(item?.adptDt),
    withdrawnDate: text(item?.scsnDt),
    subscriberCount: count(item?.jnngpCnt),
    monthlyNoticeAmount: count(item?.crrmmNtcAmt ?? item?.ntcAmt),
    newSubscriberCount: optionalCount(item?.nwAcqzrCnt),
    lostSubscriberCount: optionalCount(item?.lssJnngpCnt)
  };
}

/** 표기 차이를 지운 비교용 문자열. 공백과 괄호·가운뎃점 같은 기호를 털어낸다. */
function normalizeKeyPart(value) {
  return String(value ?? "").replace(/[\s()（）.,·\-]/g, "").toLowerCase();
}

/**
 * 같은 사업장으로 볼 기준. 사업장명·사업자등록번호 앞 6자리·도로명주소가 모두 같으면
 * 같은 사업장으로 본다. 주소를 넣어야 이름과 앞 6자리가 같은 지점들이 뭉개지지 않는다.
 */
export function workplaceIdentity(workplace) {
  return [
    normalizeKeyPart(workplace?.name),
    String(workplace?.bizNoPrefix ?? ""),
    normalizeKeyPart(workplace?.address)
  ].join("|");
}

/**
 * 이 API는 자료생성년월마다 같은 사업장을 한 건씩 쌓아 돌려준다. 같은 사업장은 기준월이
 * 가장 최근인 한 건으로 접고, 몇 개월치가 있었는지와 기준월 목록을 함께 남긴다.
 * 목록에 없는 사업장을 만들어내지 않도록 순서는 처음 나온 차례를 지킨다.
 */
export function mergeWorkplaceHistory(workplaces) {
  // 이미 한 번 접힌 목록을 다시 접어도 이력이 사라지지 않도록 기준월 목록을 함께 모은다.
  const monthsOf = (workplace) => [workplace?.dataCreatedMonth, ...(workplace?.historyMonths ?? [])].filter(Boolean);
  const groups = new Map();
  for (const workplace of workplaces ?? []) {
    const key = workplaceIdentity(workplace);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { latest: workplace, months: new Set(monthsOf(workplace)) });
      continue;
    }
    for (const month of monthsOf(workplace)) group.months.add(month);
    if (text(workplace.dataCreatedMonth) > text(group.latest.dataCreatedMonth)) group.latest = workplace;
  }
  return [...groups.values()].map(({ latest, months }) => ({
    ...latest,
    historyCount: months.size || 1,
    historyMonths: [...months].sort().reverse()
  }));
}

// 공공데이터포털 게이트웨이가 돌려주는 오류 코드별 안내. 화면에 그대로 보여줄 수 있는 문장이다.
export const NPS_ERROR_HINTS = {
  "4": "국민연금 API 서버가 제때 응답하지 않았습니다. 잠시 후 다시 시도해 주세요.",
  "12": "폐기되었거나 주소가 바뀐 서비스입니다. 오퍼레이션 주소를 확인하세요.",
  "20": "서비스 접근이 거부되었습니다. 활용신청 승인 상태를 확인하세요.",
  "22": "일일 트래픽 한도를 초과했습니다.",
  "30": "등록되지 않은 서비스키입니다. 인코딩 키가 아닌 디코딩 키를 NPS_SERVICE_KEY에 넣었는지 확인하세요.",
  "31": "활용기간이 만료된 서비스키입니다.",
  "32": "등록되지 않은 IP에서의 호출입니다.",
  "97": "요청 파라미터가 규격과 맞지 않습니다. 파라미터 이름과 값(numOfRows 최대 100, 시군구는 시도를 포함한 5자리 법정동코드)을 확인하세요.",
  "99": "국민연금 API 내부 오류입니다."
};

// 요청을 고쳐 다시 부를 여지가 없는 코드. 키·권한·한도 문제는 재시도해도 같은 답이 온다.
const UNRECOVERABLE_ERROR_CODES = new Set(["12", "20", "22", "30", "31", "32"]);

function npsError(code, message) {
  const error = new Error(message);
  if (code) error.code = String(code);
  return error;
}

/** 오류 코드에 해당하는 안내를 덧붙인 메시지를 만든다. */
export function describeNpsError(error) {
  const hint = NPS_ERROR_HINTS[String(error?.code ?? "")];
  return hint ? `${error.message} (${hint})` : String(error?.message ?? "국민연금 API 오류");
}

/** 파라미터 표기를 바꿔 다시 호출해 볼 만한 오류인지 판정한다. */
export function isRequestShapeError(error) {
  const code = String(error?.code ?? "");
  return Boolean(code) && !UNRECOVERABLE_ERROR_CODES.has(code);
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

function decodeXmlText(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (whole, entity) => XML_ENTITIES[entity] ?? whole)
    .trim();
}

/**
 * 이 서비스는 resultType 파라미터와 무관하게 XML로 응답한다. 봉투가 평평해서
 * item 블록과 그 자식 태그만 훑어도 필요한 값을 모두 얻을 수 있다.
 */
export function parseNpsXml(xml) {
  const source = String(xml ?? "");
  const tag = (name) => {
    const match = source.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return match ? decodeXmlText(match[1]) : "";
  };

  const authMessage = tag("returnAuthMsg") || tag("errMsg");
  if (authMessage) {
    const reason = tag("returnReasonCode") || tag("errorCode");
    throw npsError(reason, `국민연금 API 오류${reason ? ` ${reason}` : ""}: ${authMessage}`);
  }
  const resultCode = tag("resultCode");
  if (resultCode && resultCode !== "00" && resultCode !== "0") {
    throw npsError(resultCode, `국민연금 API 오류 ${resultCode}: ${tag("resultMsg") || "사유 미상"}`);
  }

  const items = [...source.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, block]) => {
    const record = {};
    for (const [, name, value] of block.matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) {
      record[name] = decodeXmlText(value);
    }
    return record;
  });

  // 빈 결과도 헤더나 items 껍데기는 남는다. 둘 다 없으면 이 서비스의 응답이 아니다.
  if (!items.length && !resultCode && !/<items\b/.test(source)) {
    throw new Error("국민연금 API 응답 형식을 해석할 수 없습니다.");
  }
  return {
    items,
    totalCount: count(tag("totalCount")),
    pageNo: count(tag("pageNo")) || 1,
    numOfRows: count(tag("numOfRows")) || items.length
  };
}

/** 본문이 JSON이든 XML이든 같은 형태로 푼다. 어느 쪽도 아니면 오류로 올린다. */
export function parseNpsBody(body) {
  const trimmed = String(body ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      throw new Error("국민연금 API 응답 형식을 해석할 수 없습니다.");
    }
    return parseNpsResponse(payload);
  }
  if (trimmed.startsWith("<")) return parseNpsXml(trimmed);
  throw new Error("국민연금 API 응답 형식을 해석할 수 없습니다.");
}

/**
 * data.go.kr 표준 JSON 응답 봉투를 푼다. items가 배열, 단일 객체, 빈 문자열로 오는 경우를 모두 받는다.
 * 정상 응답이 아니면 헤더의 결과 메시지를 담아 throw 한다.
 */
export function parseNpsResponse(payload) {
  const body = payload?.response?.body;
  const header = payload?.response?.header;
  const resultCode = text(header?.resultCode);
  if (resultCode && resultCode !== "00" && resultCode !== "0") {
    throw npsError(resultCode, `국민연금 API 오류 ${resultCode}: ${text(header?.resultMsg) || "사유 미상"}`);
  }
  if (!body) throw new Error("국민연금 API 응답 형식을 해석할 수 없습니다.");
  const raw = body.items?.item ?? body.items ?? [];
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return {
    items,
    totalCount: count(body.totalCount),
    pageNo: count(body.pageNo) || 1,
    numOfRows: count(body.numOfRows) || items.length
  };
}

function rank(items, key) {
  return [...items.reduce((counts, item) => {
    const value = typeof key === "function" ? key(item) : item[key];
    const name = value || "미상";
    counts.set(name, (counts.get(name) || 0) + 1);
    return counts;
  }, new Map())]
    .map(([name, total]) => ({ name, count: total }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
}

/** 수집한 사업장 목록의 통계. 목록 API에는 가입자 수가 없으므로 사업장 수만 집계한다. */
export function summarizeWorkplaces(workplaces) {
  const registered = workplaces.filter((workplace) => workplace.statusCode === "1").length;
  const withdrawn = workplaces.filter((workplace) => workplace.statusCode === "2").length;
  const corporate = workplaces.filter((workplace) => workplace.styleCode === "1").length;
  return {
    total: workplaces.length,
    registered,
    withdrawn,
    corporate,
    individual: workplaces.filter((workplace) => workplace.styleCode === "2").length,
    registeredRatio: workplaces.length ? registered / workplaces.length : 0,
    corporateRatio: workplaces.length ? corporate / workplaces.length : 0,
    sections: rank(workplaces, "sectionName"),
    areas: rank(workplaces, "area"),
    statuses: rank(workplaces, "statusName"),
    styles: rank(workplaces, "styleName"),
    months: rank(workplaces, "dataCreatedMonth")
  };
}
