import {
  buildLocationFilter,
  buildLocationSelection,
  countBy,
  filterStores,
  pointInGeometry,
  sortStores
} from "./lib/market.js";
import { filterVworldZones, mergeZoneFeatures } from "./lib/zone-update.js";
import { axisTicks, barBands, barCornerRadius, barWidth, columnBands, linePath, linePoints } from "./lib/chart.js";
import { AREA_SHAPES, areaPolygonGeometry } from "./lib/area-search.js";
import { closureLifespanMedianDays, closureRateTableWithLifespan, closureYearCounts, filterClosureRows } from "./lib/closure-view.js";
import {
  averageClosureRate,
  closuresInZone,
  recentRateYearRange,
  zoneClosureYearRates
} from "./lib/zone-closure.js";
import { DONGGU_ADMIN_DONGS } from "./lib/admin-dong.js";
import {
  INDUSTRY_SECTIONS,
  displayAddress,
  hasIndustryDetail,
  hydrateSnapshotWorkplace,
  ymdYear
} from "./lib/nps.js";
import {
  EMPLOYMENT_INSURANCE_SNAPSHOT_URL,
  insuranceTypeName,
  mergeEmploymentInsuranceRows
} from "./lib/employment-insurance.js";
import {
  combineInsuranceWorkplaces,
  insuranceAdminDongs,
  insuranceIndustrySectionCodes,
  matchesInsuranceWorkplaceCriteria,
  sortInsuranceWorkplaces
} from "./lib/insurance-workplaces.js";
import {
  boundsIntersect,
  boundsPolygon,
  clipGeometryToBounds,
  filterBuildingsInZone,
  geometryBounds,
  geometryIntersects,
  expandBoundsMeters,
  matchBuildingIndustries,
  rowsBounds
} from "./lib/building-outline.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);

let toastTimer;
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

// Service navigation
const tabs = [...document.querySelectorAll(".primary-tab")];
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateService(tab.dataset.panel));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    next.focus();
    activateService(next.dataset.panel);
  });
});

function activateService(panelName) {
  tabs.forEach((tab) => {
    const active = tab.dataset.panel === panelName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    $(`panel-${tab.dataset.panel}`).hidden = !active;
  });
  closeClusterPanel();
  closeOutlinePanel();
  if (panelName === "market") initializeMarket();
  if (panelName === "stats") initializeStats();
}

// Business lookup sub-navigation
const subTabs = [...document.querySelectorAll("[data-subpanel]")];
subTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateBusinessLookup(tab.dataset.subpanel));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = subTabs[(index + direction + subTabs.length) % subTabs.length];
    next.focus();
    activateBusinessLookup(next.dataset.subpanel);
  });
});

function activateBusinessLookup(subpanelName) {
  subTabs.forEach((tab) => {
    const active = tab.dataset.subpanel === subpanelName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    $(`subpanel-${tab.dataset.subpanel}`).hidden = !active;
  });
}

// Business status lookup
let allResults = [];
let currentBusinessFilter = "all";
let shouldStop = false;

function parseNumbers(raw) {
  return raw.split(/[\n,\t]+/)
    .map((value) => value.replace(/[^0-9]/g, "").trim())
    .filter(Boolean);
}

function validateBizNo(number) {
  if (number.length !== 10) return false;
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(number[index]) * weights[index];
  sum += Math.floor((Number(number[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(number[9]);
}

function formatBizNo(number) {
  return `${number.slice(0, 3)}-${number.slice(3, 5)}-${number.slice(5)}`;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function updateInputCount() {
  const count = parseNumbers($("inputArea").value).length;
  $("countBadge").textContent = `${count.toLocaleString("ko-KR")}건 입력`;
}

function badge(type, value, code) {
  if (type === "result") {
    if (value === "format") return '<span class="badge badge-red">형식 오류</span>';
    if (value === "api") return '<span class="badge badge-yellow">API 오류</span>';
    if (!value) return '<span class="badge badge-gray">미등록</span>';
    return '<span class="badge badge-green">조회 성공</span>';
  }
  if (type === "tax") {
    if (!value) return '<span class="badge badge-gray">-</span>';
    const label = escapeHtml(value.replace("부가가치세 ", "").replace("과세자", "").trim());
    if (code === "01") return `<span class="badge badge-green">${label}</span>`;
    if (code === "02") return `<span class="badge badge-yellow">${label}</span>`;
    return `<span class="badge badge-gray">${label}</span>`;
  }
  if (!value) return '<span class="badge badge-gray">-</span>';
  if (code === "01") return '<span class="badge badge-green">계속사업자</span>';
  if (code === "02") return '<span class="badge badge-yellow">휴업</span>';
  if (code === "03") return '<span class="badge badge-red">폐업</span>';
  return `<span class="badge badge-gray">${escapeHtml(value)}</span>`;
}

function filteredBusinessResults() {
  if (currentBusinessFilter === "active") return allResults.filter((row) => row.b_stt_cd === "01");
  if (currentBusinessFilter === "closed") return allResults.filter((row) => ["02", "03"].includes(row.b_stt_cd));
  if (currentBusinessFilter === "error") {
    return allResults.filter((row) => row.formatError || row.apiError || (!row.b_stt && !row.pending));
  }
  return allResults;
}

function renderBusinessTable() {
  const rows = filteredBusinessResults();
  if (!rows.length) {
    $("resultBody").innerHTML = '<tr class="empty-row"><td colspan="6">해당 조건의 결과가 없습니다.</td></tr>';
    return;
  }
  $("resultBody").innerHTML = rows.map((row, index) => {
    const rowClass = row.formatError || row.apiError ? "row-error" : row.pending ? "row-pending" : "";
    const resultKey = row.formatError ? "format" : row.apiError ? "api" : row.b_stt;
    const closeDate = row.end_dt?.replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3") || "-";
    return `<tr class="${rowClass}">
      <td class="seq">${index + 1}</td>
      <td class="mono">${escapeHtml(formatBizNo(row.b_no))}</td>
      <td>${badge("result", resultKey)}</td>
      <td>${badge("tax", row.tax_type, row.tax_type_cd)}</td>
      <td>${badge("status", row.b_stt, row.b_stt_cd)}</td>
      <td class="mono">${escapeHtml(closeDate)}</td>
    </tr>`;
  }).join("");
}

function renderBusinessStats() {
  const active = allResults.filter((row) => row.b_stt_cd === "01").length;
  const closed = allResults.filter((row) => ["02", "03"].includes(row.b_stt_cd)).length;
  const errors = allResults.filter((row) => row.formatError || row.apiError || (!row.b_stt && !row.pending)).length;
  $("statsRow").innerHTML = `
    <span class="stat-item">전체<strong>${allResults.length}</strong></span>
    <span class="stat-item">계속사업자<strong>${active}</strong></span>
    <span class="stat-item">휴·폐업<strong>${closed}</strong></span>
    <span class="stat-item">오류·미등록<strong>${errors}</strong></span>`;
}

async function callBusinessProxy(numbers) {
  const response = await fetch("/api/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ b_no: numbers })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.data || [];
}

async function runBusinessLookup() {
  const numbers = parseNumbers($("inputArea").value);
  if (!numbers.length) {
    showToast("조회할 사업자등록번호를 입력해 주세요.");
    return;
  }

  shouldStop = false;
  $("runBtn").disabled = true;
  $("stopBtn").hidden = false;
  $("progressWrap").hidden = false;
  $("resultSection").hidden = false;
  $("progressFill").style.width = "0%";

  allResults = numbers.map((number) => ({
    b_no: number,
    formatError: !validateBizNo(number),
    b_stt: null,
    b_stt_cd: null,
    tax_type: null,
    tax_type_cd: null,
    end_dt: null,
    apiError: false,
    pending: validateBizNo(number)
  }));
  renderBusinessTable();
  renderBusinessStats();

  const validRows = allResults.filter((row) => !row.formatError);
  let done = 0;
  for (const group of chunk(validRows, 100)) {
    if (shouldStop) break;
    try {
      const responseRows = await callBusinessProxy(group.map((row) => row.b_no));
      const byNumber = new Map(responseRows.map((row) => [row.b_no, row]));
      group.forEach((row) => {
        const data = byNumber.get(row.b_no);
        if (data) Object.assign(row, {
          b_stt: data.b_stt || null,
          b_stt_cd: data.b_stt_cd || null,
          tax_type: data.tax_type || null,
          tax_type_cd: data.tax_type_cd || null,
          end_dt: data.end_dt || null
        });
        row.pending = false;
      });
    } catch (error) {
      group.forEach((row) => { row.apiError = true; row.pending = false; });
      showToast(error.message);
    }
    done += group.length;
    const percent = validRows.length ? Math.round(done / validRows.length * 100) : 100;
    $("progressFill").style.width = `${percent}%`;
    $("progressText").textContent = `${done.toLocaleString("ko-KR")} / ${validRows.length.toLocaleString("ko-KR")}건 처리 (${percent}%)`;
    renderBusinessTable();
    renderBusinessStats();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  $("runBtn").disabled = false;
  $("stopBtn").hidden = true;
  $("progressFill").style.width = "100%";
  $("progressText").textContent = shouldStop ? "사용자가 조회를 중단했습니다." : `완료: 총 ${numbers.length.toLocaleString("ko-KR")}건`;
  renderBusinessTable();
  renderBusinessStats();
  showToast(shouldStop ? "조회가 중단되었습니다." : "사업자 상태 조회가 완료되었습니다.");
}

function downloadBusinessCsv() {
  if (!allResults.length) return;
  const headers = ["순번", "사업자등록번호", "형식오류", "사업자상태", "상태코드", "과세유형", "과세유형코드", "폐업일"];
  const rows = allResults.map((row, index) => [
    index + 1,
    formatBizNo(row.b_no),
    row.formatError ? "형식오류" : "",
    row.b_stt || (row.apiError ? "API오류" : "미등록"),
    row.b_stt_cd || "",
    row.tax_type || "",
    row.tax_type_cd || "",
    row.end_dt?.replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3") || ""
  ]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")}`;
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.href = url;
  link.download = `사업자조회_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("CSV 파일을 내려받았습니다.");
}

$("inputArea").addEventListener("input", updateInputCount);
$("runBtn").addEventListener("click", runBusinessLookup);
$("stopBtn").addEventListener("click", () => { shouldStop = true; $("stopBtn").hidden = true; });
$("sampleBtn").addEventListener("click", () => {
  $("inputArea").value = "1234567890\n2208808965\n1068617609\n2148788166\n1138600998";
  updateInputCount();
});
$("clearBtn").addEventListener("click", () => { $("inputArea").value = ""; updateInputCount(); });
$("downloadBtn").addEventListener("click", downloadBusinessCsv);
$("businessFilterTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  currentBusinessFilter = button.dataset.filter;
  document.querySelectorAll("#businessFilterTabs .filter-chip").forEach((chip) => {
    const active = chip === button;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  renderBusinessTable();
});

let validationBusy = false;
const validationDateSegments = [
  $("validationStartYear"),
  $("validationStartMonth"),
  $("validationStartDay")
];

function focusValidationDateSegment(input) {
  input.focus();
  input.select();
}

function fillValidationDateSegments(startIndex, digits) {
  let remaining = digits;
  let lastIndex = startIndex;
  for (let index = startIndex; index < validationDateSegments.length && remaining; index += 1) {
    const input = validationDateSegments[index];
    const size = Number(input.maxLength);
    input.value = remaining.slice(0, size);
    remaining = remaining.slice(size);
    lastIndex = index;
  }
  const next = validationDateSegments[lastIndex + 1];
  if (next && validationDateSegments[lastIndex].value.length === Number(validationDateSegments[lastIndex].maxLength)) {
    focusValidationDateSegment(next);
  } else {
    focusValidationDateSegment(validationDateSegments[lastIndex]);
  }
}

validationDateSegments.forEach((input, index) => {
  const previous = validationDateSegments[index - 1];
  const next = validationDateSegments[index + 1];
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^0-9]/g, "").slice(0, input.maxLength);
    if (next && input.value.length === input.maxLength) focusValidationDateSegment(next);
  });
  input.addEventListener("paste", (event) => {
    const digits = event.clipboardData?.getData("text").replace(/[^0-9]/g, "") || "";
    if (digits.length <= input.maxLength) return;
    event.preventDefault();
    fillValidationDateSegments(index, digits);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" && !input.value && previous) {
      focusValidationDateSegment(previous);
    } else if (event.key === "ArrowLeft" && previous && input.selectionStart === 0) {
      focusValidationDateSegment(previous);
    } else if (event.key === "ArrowRight" && next && input.selectionStart === input.value.length) {
      focusValidationDateSegment(next);
    }
  });
});

function validationFormValues() {
  const bNo = $("validationBizNo").value.replace(/[^0-9]/g, "");
  const owner = $("validationOwner").value.trim();
  const startDate = validationDateSegments.map((input) => input.value).join("");

  if (!bNo) {
    showToast("사업자등록번호를 입력해 주세요.");
    $("validationBizNo").focus();
    return null;
  }
  if (!/^\d{10}$/.test(bNo)) {
    showToast("사업자등록번호는 10자리 숫자로 입력해 주세요.");
    $("validationBizNo").focus();
    return null;
  }
  if (!owner) {
    showToast("대표자명을 입력해 주세요.");
    $("validationOwner").focus();
    return null;
  }
  if (startDate.length !== 8) {
    showToast("개업일자를 연 4자리, 월 2자리, 일 2자리로 입력해 주세요.");
    validationDateSegments.find((input) => input.value.length < input.maxLength)?.focus();
    return null;
  }

  return {
    b_no: bNo,
    start_dt: startDate,
    p_nm: owner
  };
}

async function callBusinessValidation(business) {
  const response = await fetch("/api/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "validate", businesses: [business] })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function renderValidationResult(item, statusRow, statusError) {
  const result = $("validationResult");
  const code = String(item?.valid ?? "");
  const state = code === "01" ? "is-valid" : code === "02" ? "is-invalid" : "is-error";
  const title = code === "01" ? "일치" : code === "02" ? "불일치" : "확인 불가";
  const message = item?.valid_msg ? `<p>${escapeHtml(item.valid_msg)}</p>` : "";
  const statusDetails = code === "01" ? `<dl class="verification-status">
    <div><dt>과세 유형</dt><dd>${badge("tax", statusRow?.tax_type, statusRow?.tax_type_cd)}</dd></div>
    <div><dt>사업자 상태</dt><dd>${badge("status", statusRow?.b_stt, statusRow?.b_stt_cd)}</dd></div>
  </dl>${statusError ? `<p class="verification-note">사업자 상태를 불러오지 못했습니다.</p>` : ""}` : "";
  result.className = `verification-result ${state}`;
  result.innerHTML = `<strong>${title}</strong>${message}${statusDetails}`;
}

function renderValidationError(message) {
  const result = $("validationResult");
  result.className = "verification-result is-error";
  result.innerHTML = `<strong>진위확인을 완료하지 못했습니다.</strong><p>${escapeHtml(message)}</p>`;
}

async function runBusinessValidation() {
  if (validationBusy) return;
  const business = validationFormValues();
  if (!business) return;

  validationBusy = true;
  $("validationRunBtn").disabled = true;
  $("validationClearBtn").disabled = true;
  $("validationResultSection").hidden = false;
  $("validationResultSection").setAttribute("aria-busy", "true");
  $("validationResult").className = "verification-result is-pending";
  $("validationResult").innerHTML = "<p>국세청 등록정보와 대조하는 중입니다.</p>";

  try {
    const payload = await callBusinessValidation(business);
    const result = payload?.data?.[0];
    if (!result) throw new Error("진위확인 결과를 받지 못했습니다.");
    let statusRow;
    let statusError = "";
    if (String(result.valid) === "01") {
      try {
        statusRow = (await callBusinessProxy([business.b_no]))[0];
        if (!statusRow) statusError = "상태조회 결과가 없습니다.";
      } catch (error) {
        statusError = error.message;
      }
    }
    renderValidationResult(result, statusRow, statusError);
    showToast(statusError
      ? "진위확인은 완료했지만 사업자 상태를 불러오지 못했습니다."
      : "사업자등록정보 진위확인이 완료되었습니다.");
  } catch (error) {
    renderValidationError(error.message);
    showToast(error.message);
  } finally {
    validationBusy = false;
    $("validationRunBtn").disabled = false;
    $("validationClearBtn").disabled = false;
    $("validationResultSection").removeAttribute("aria-busy");
  }
}

$("validationRunBtn").addEventListener("click", runBusinessValidation);
$("validationClearBtn").addEventListener("click", () => {
  $("validationBizNo").value = "";
  $("validationOwner").value = "";
  validationDateSegments.forEach((input) => { input.value = ""; });
  $("validationResultSection").hidden = true;
  $("validationResult").replaceChildren();
});
[
  $("validationBizNo"),
  $("validationOwner"),
  ...validationDateSegments
].forEach((input) => input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runBusinessValidation();
}));

// Commercial district analysis
const DONGGU_CENTER = [35.1467, 126.9231];
let marketInitialized = false;
let allStores = [];
// 행정동 → 그 행정동에 속한 법정동코드(건물 PNU 앞 10자리) 집합.
// 행정동 경계 자료가 없어도 건물을 행정동별로 가릴 수 있게 해 준다.
const dongLegalCodes = new Map();
let visibleStores = [];
let marketMeta = null;
let marketMap;
let markerCluster;
let storeMarkers = [];
let mainBizZones = [];
let zoneLayer;
let selectedZoneNo = "";
const zoneLeafletByNo = new Map();
const CLUSTER_CHART_COLORS = ["#1d5e8c", "#49a36f", "#e09b32", "#8b67ad", "#d66161", "#93a0ad"];
const SMALL_CHART_COLORS = [
  ...CLUSTER_CHART_COLORS,
  "#5b98ff", "#f2ce68", "#45d69a", "#e88eaf", "#6fcbd7", "#94cf73", "#90a4bf", "#c4879e"
];
const MARKET_TABLE_PAGE_SIZE = 100;
let marketTableRows = [];
let marketTablePageNo = 1;
let marketTableAppliedLabel = "";
const MARKET_STORE_PANEL = {
  panelId: "clusterPanel",
  countId: "clusterPanelCount",
  storeBodyId: "clusterStoreBody",
  statsId: "clusterStats",
  statsMetaId: "clusterStatsMeta",
  pieId: "clusterPie",
  legendId: "clusterLegend",
  bodyId: "clusterPanelBody"
};
const OUTLINE_STORE_PANEL = {
  panelId: "outlinePanel",
  countId: "outlinePanelCount",
  storeBodyId: "outlineStoreBody",
  statsId: "outlineStats",
  statsMetaId: "outlineStatsMeta",
  pieId: "outlinePie",
  legendId: "outlinePanelLegend",
  bodyId: "outlinePanelBody"
};

const marketViewTabs = [...document.querySelectorAll(".market-view-tab")];
function activateMarketView(viewName) {
  marketViewTabs.forEach((tab) => {
    const active = tab.dataset.marketView === viewName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    $(`market-view-${tab.dataset.marketView}`).hidden = !active;
  });
  closeClusterPanel();
  closeOutlinePanel();
  if (viewName === "map") setTimeout(() => marketMap?.invalidateSize(), 0);
  if (viewName === "analysis") initializeBuildingOutline();
}

marketViewTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateMarketView(tab.dataset.marketView));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = marketViewTabs[(index + direction + marketViewTabs.length) % marketViewTabs.length];
    next.focus();
    activateMarketView(next.dataset.marketView);
  });
});
const OUTLINE_MANIFEST_URL = "data/figure-ground/manifest.json";
const OUTLINE_INDUSTRY_COLORS = new Map([
  ["소매", "#5b98ff"],
  ["음식", "#f2ce68"],
  ["과학·기술", "#b88af5"],
  ["수리·개인", "#45d69a"],
  ["교육", "#e88eaf"],
  ["부동산", "#90a4bf"],
  ["시설관리·임대", "#c4879e"],
  ["예술·스포츠", "#6fcbd7"],
  ["숙박", "#ff8585"],
  ["보건의료", "#94cf73"]
]);
const OUTLINE_OTHER_COLOR = "#c4879e";
const OUTLINE_UNMATCHED_COLOR = "#586276";
const OUTLINE_UNKNOWN_COLOR = "#8793a8";
const OUTLINE_PLAIN_COLOR = "#aeb9cb";
const OUTLINE_MAP_MIN_ZOOM = 12;
const OUTLINE_MAP_MAX_ZOOM = 19;
const OUTLINE_MAP_ZOOM_MARGIN = 2;
const OUTLINE_MAP_BOUNDS_PADDING = .12;
const OUTLINE_ROAD_CLIP_BUFFER_METERS = 80;
const OUTLINE_ROADS_URL = "data/road-polygons-donggu.geojson";
let outlineMap;
let outlineManifest = null;
let outlineGroundLayer;
let outlineRoadLayer;
let outlineBuildingLayer;
let outlineFeatures = [];
let outlineRoadFeatures = [];
let outlineIndustryById = new Map();
let outlineStoresById = new Map();
let outlineLoadId = 0;
const outlineCellCache = new Map();
let outlineRoadFeaturesCache = null;

function outlineIndustryColor(industry) {
  if (industry === "점포 미연결") return OUTLINE_UNMATCHED_COLOR;
  if (industry === "업종 미확인" || industry === "미분류") return OUTLINE_UNKNOWN_COLOR;
  if (industry === "기타") return OUTLINE_OTHER_COLOR;
  return OUTLINE_INDUSTRY_COLORS.get(industry) || OUTLINE_OTHER_COLOR;
}

function chartIndustryColor(industry, index) {
  if (OUTLINE_INDUSTRY_COLORS.has(industry)) return OUTLINE_INDUSTRY_COLORS.get(industry);
  if (industry === "기타") return OUTLINE_OTHER_COLOR;
  if (industry === "업종 미확인" || industry === "미분류") return OUTLINE_UNKNOWN_COLOR;
  return SMALL_CHART_COLORS[index % SMALL_CHART_COLORS.length];
}

async function initializeMarket() {
  if (marketInitialized) {
    if (!$("market-view-analysis").hidden) initializeBuildingOutline();
    else setTimeout(() => marketMap?.invalidateSize(), 0);
    return;
  }
  marketInitialized = true;
  try {
    const [response, zoneResponse, manualZoneResponse] = await Promise.all([
      fetch("data/stores_donggu.json"),
      fetch("data/mainbiz_zones_donggu.geojson").catch(() => null),
      fetch("data/manual_mainbiz_zones_donggu.geojson").catch(() => null)
    ]);
    if (!response.ok) throw new Error(`상가정보 파일을 불러오지 못했습니다. HTTP ${response.status}`);
    const payload = await response.json();
    let zonePayload = { features: [], meta: {} };
    if (zoneResponse?.ok) {
      try {
        zonePayload = await zoneResponse.json();
      } catch (error) {
        console.error("[mainbiz-zones] invalid JSON", error);
      }
    }
    let manualZonePayload = { features: [] };
    if (manualZoneResponse?.ok) {
      try {
        manualZonePayload = await manualZoneResponse.json();
      } catch (error) {
        console.error("[manual-mainbiz-zones] invalid JSON", error);
      }
    }
    const baseStores = Array.isArray(payload.stores) ? payload.stores : [];
    marketMeta = payload.meta || {};
    allStores = baseStores;
    dongLegalCodes.clear();
    for (const store of allStores) {
      const pnu = String(store.pnu || "");
      if (!store.adminDong || !/^\d{10}/.test(pnu)) continue;
      const codes = dongLegalCodes.get(store.adminDong) || new Set();
      codes.add(pnu.slice(0, 10));
      dongLegalCodes.set(store.adminDong, codes);
    }
    const visibleVworldPayload = { features: filterVworldZones(zonePayload.features) };
    mainBizZones = mergeZoneFeatures(visibleVworldPayload, manualZonePayload);
    if (!allStores.length) throw new Error("상가정보 파일에 표시할 업소가 없습니다.");
    initializeMap();
    populateMarketFilters();
    try {
      buildZoneLayer();
    } catch (error) {
      console.error("[mainbiz-zones] layer unavailable", error);
      mainBizZones = [];
      zoneLayer = null;
      populateMarketFilters();
    }
    buildStoreMarkers();
    applyMarketFilters();
    renderMarketMeta();
    $("marketState").hidden = true;
    $("marketWorkspace").hidden = false;
    setTimeout(() => marketMap.invalidateSize(), 0);
    if (!$("market-view-analysis").hidden) initializeBuildingOutline();
    // 폐업 분석을 먼저 열어 두면 분모가 비어 있으므로, 상가 자료가 도착한 뒤 다시 센다.
    renderStats();
  } catch (error) {
    $("marketState").classList.add("is-error");
    $("marketState").textContent = `${error.message} 데이터 갱신 스크립트를 먼저 실행해 주세요.`;
  }
}

function renderMarketMeta() {
  const month = String(marketMeta.standardMonth || "").replace(/^(\d{4})(\d{2})$/, "$1.$2");
  const generated = marketMeta.generatedAt
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" }).format(new Date(marketMeta.generatedAt))
    : "미확인";
  const source = marketMeta?.source || "상가정보 API";
  const dates = [
    month ? `상가정보 기준월 ${month}` : "",
    `상가정보 갱신일 ${generated}`
  ].filter(Boolean).join(" · ");
  $("marketMeta").textContent = [source, dates].filter(Boolean).join(" · ");
}

function initializeMap() {
  marketMap = L.map("marketMap", { zoomControl: true, preferCanvas: true }).setView(DONGGU_CENTER, 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(marketMap);
  markerCluster = L.markerClusterGroup({
    chunkedLoading: true,
    chunkInterval: 100,
    chunkDelay: 30,
    maxClusterRadius: 46,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,
    spiderfyOnMaxZoom: false
  }).addTo(marketMap);
  markerCluster.on("clusterclick", (event) => {
    if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
    const stores = event.layer.getAllChildMarkers().map((marker) => marker.store).filter(Boolean);
    renderClusterPanel(stores);
  });
  marketMap.on("click", closeClusterPanel);
}

function closeClusterPanel() {
  closeStorePanel(MARKET_STORE_PANEL);
}

function closeOutlinePanel() {
  closeStorePanel(OUTLINE_STORE_PANEL);
}

function closeStorePanel(panelConfig) {
  const panel = $(panelConfig.panelId);
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  $(panelConfig.storeBodyId).replaceChildren();
  $(panelConfig.statsId).hidden = true;
}

function clusterIndustryRows(stores) {
  const categories = countBy(stores, (store) => store.largeName || store.middleName || store.smallName || "미분류");
  const rows = categories.slice(0, 5);
  const otherCount = categories.slice(5).reduce((total, item) => total + item.count, 0);
  if (otherCount) rows.push({ name: "기타", count: otherCount });
  return { categories, rows };
}

function renderStoreIndustryChart(stores, panelConfig) {
  const { categories, rows } = clusterIndustryRows(stores);
  let offset = 0;
  const segments = rows.map((row, index) => {
    const start = offset;
    offset += row.count / stores.length * 100;
    return `${chartIndustryColor(row.name, index)} ${start}% ${offset}%`;
  });
  const pie = $(panelConfig.pieId);
  pie.style.background = `conic-gradient(${segments.join(",")})`;
  pie.setAttribute("aria-label", `총 ${stores.length}개 업소의 업종 분포`);
  $(panelConfig.statsMetaId).textContent = `총 ${stores.length.toLocaleString("ko-KR")}개 · ${categories.length.toLocaleString("ko-KR")}개 업종`;
  $(panelConfig.legendId).innerHTML = rows.map((row, index) => `<div>
    <i style="background:${chartIndustryColor(row.name, index)}"></i>
    <span>${escapeHtml(row.name)}</span>
    <strong>${row.count.toLocaleString("ko-KR")}개</strong>
  </div>`).join("");
  $(panelConfig.statsId).hidden = false;
}

function topIndustryRows(stores, field, limit = 10) {
  const categories = countBy(stores, (store) => store[field] || "미분류");
  const rows = categories.slice(0, limit);
  const otherCount = categories.slice(limit).reduce((total, item) => total + item.count, 0);
  if (otherCount) rows.push({ name: "기타", count: otherCount });
  return { categories, rows };
}

function renderIndustryPieChart(stores, config) {
  const { categories, rows } = topIndustryRows(stores, config.field);
  const total = stores.length;
  let offset = 0;
  const segments = rows.map((row, index) => {
    const start = offset;
    offset += total ? row.count / total * 100 : 0;
    return `${chartIndustryColor(row.name, index)} ${start}% ${offset}%`;
  });
  const pie = $(config.pieId);
  pie.style.background = segments.length ? `conic-gradient(${segments.join(",")})` : "var(--line)";
  pie.setAttribute("aria-label", `${config.title} 총 ${total.toLocaleString("ko-KR")}개 업소의 업종 분포`);
  $(config.legendId).innerHTML = rows.map((row, index) => `<div class="outline-stat-legend-row">
    <i style="background:${chartIndustryColor(row.name, index)}"></i>
    <span title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
    <strong>${row.count.toLocaleString("ko-KR")}개</strong>
  </div>`).join("");
  return categories.length;
}

function clearOutlineStatistics() {
  const statistics = $("outlineStatistics");
  if (!statistics) return;
  statistics.hidden = true;
  $("outlineStatisticsMeta").textContent = "";
  ["outlineLargePie", "outlineSmallPie"].forEach((id) => {
    $(id).style.removeProperty("background");
    $(id).removeAttribute("aria-label");
  });
  ["outlineLargeLegend", "outlineSmallLegend"].forEach((id) => $(id).replaceChildren());
}

function renderOutlineZoneStatistics(stores, zoneName) {
  if (!stores.length) {
    clearOutlineStatistics();
    return;
  }
  const largeCategoryCount = renderIndustryPieChart(stores, {
    field: "largeName",
    title: "업종 대분류",
    pieId: "outlineLargePie",
    legendId: "outlineLargeLegend"
  });
  const smallCategoryCount = renderIndustryPieChart(stores, {
    field: "smallName",
    title: "업종 소분류",
    pieId: "outlineSmallPie",
    legendId: "outlineSmallLegend"
  });
  $("outlineStatisticsMeta").textContent = `${zoneName} · ${stores.length.toLocaleString("ko-KR")}개 업소 · 대분류 ${largeCategoryCount}개 · 소분류 ${smallCategoryCount}개 · 상위 10개 + 기타`;
  $("outlineStatistics").hidden = false;
}

function clearZoneClosure() {
  $("outlineClosure").hidden = true;
  $("outlineClosureMeta").textContent = "";
  ["outlineClosureLifespanValue", "outlineClosureRateValue"].forEach((id) => { $(id).textContent = "-"; });
  ["outlineClosureLifespanNote", "outlineClosureRateNote"].forEach((id) => { $(id).textContent = ""; });
}

// 스냅샷을 뜬 해는 폐업이 아직 다 들어오지 않았다. 비율은 마지막으로 다 채워진 해까지만 센다.
function lastCompleteClosureYear() {
  const generated = closureMeta?.generatedAt ? new Date(closureMeta.generatedAt) : null;
  const year = generated && !Number.isNaN(generated.getTime()) ? generated.getFullYear() : new Date().getFullYear();
  return year - 1;
}

// 폐업 스냅샷은 통계 탭과 같은 파일을 쓴다. 상권 분석을 먼저 열어도 여기서 한 번 읽어 둔다.
// zone.adminDong이 있으면 상권 경계 대신 행정동 이름으로 폐업 기록을 가린다(좌표 없는 기록도 셈).
async function renderZoneClosure(zone, activeStores) {
  const zoneName = zone.properties?.name || "선택 상권";
  try {
    await loadClosureSnapshot();
  } catch (error) {
    clearZoneClosure();
    console.warn("[zone-closure] snapshot unavailable", error);
    return;
  }
  // 그리는 동안 다른 상권·영역·행정동으로 바뀌었으면 포기한다.
  const stale = zone.adminDong
    ? $("outlineDongFilter").value !== zone.adminDong
    : customAreaFeature ? zone !== customAreaFeature : selectedZone() !== zone;
  if (stale) return;

  const { rows } = zone.adminDong
    ? { rows: (closureLicenses || []).filter((row) => row.statusKind === "closed" && row.adminDong === zone.adminDong) }
    : closuresInZone(closureLicenses, zone.geometry);
  if (!rows.length) {
    clearZoneClosure();
    return;
  }

  const medianDays = closureLifespanMedianDays(rows);
  const range = recentRateYearRange(rows, { throughYear: lastCompleteClosureYear() });
  const years = range ? zoneClosureYearRates(activeStores, rows, range) : [];
  const average = averageClosureRate(years);

  $("outlineClosureMeta").textContent = `${zoneName} · 폐업 ${rows.length.toLocaleString("ko-KR")}건`;

  // 건수는 기록이 있는 해 전부를, 비율은 그중 다 채워진 최근 10년만 그린다. 가로축은 건수 쪽에 맞춘다.
  const counts = closureYearCounts(rows);
  const rateByYear = new Map(years.map(({ year, rate }) => [year, rate]));
  const percentFormat = (value) => `${value.toFixed(1)}%`;
  drawComboChart($("outlineClosureTrendChart"), {
    categories: counts.map(({ year }) => `${year}년`),
    bars: {
      label: "폐업",
      values: counts.map(({ count }) => count),
      format: (value) => `${value.toLocaleString("ko-KR")}건`
    },
    line: {
      label: "폐업률",
      values: counts.map(({ year }) => {
        const rate = rateByYear.get(year);
        return Number.isFinite(rate) ? rate * 100 : null;
      }),
      format: percentFormat
    },
    emptyText: "폐업 기록이 없습니다."
  });
  fillTableRows($("outlineClosureTable"), counts.map(({ year, count }) => {
    const rate = rateByYear.get(year);
    return [`${year}년`, count.toLocaleString("ko-KR"), Number.isFinite(rate) ? percentFormat(rate * 100) : "-"];
  }), 3);

  $("outlineClosureLifespanValue").textContent = Number.isFinite(medianDays)
    ? `${(medianDays / 365).toFixed(1)}년`
    : "-";
  $("outlineClosureLifespanNote").textContent = Number.isFinite(medianDays)
    ? `폐업한 ${rows.length.toLocaleString("ko-KR")}곳이 문을 열고 닫기까지 걸린 기간의 중앙값입니다.`
    : "영업기간을 낼 수 있는 폐업 기록이 없습니다.";
  $("outlineClosureRateValue").textContent = average === null ? "-" : percentFormat(average * 100);
  // 그 해에 영업 중이던 곳을 인허가일로 되돌려 세므로, 인허가일이 없는 상가정보 출신 업소는 빠진다.
  $("outlineClosureRateNote").textContent = average === null
    ? "비율을 낼 수 있는 폐업 기록이 없습니다."
    : `${range.fromYear}~${range.toYear}년 각 해의 폐업률을 평균했습니다. 분모는 그 해 영업 중이던 인허가 업소입니다.`;
  $("outlineClosure").hidden = false;
}

function renderStorePanel(stores, panelConfig) {
  const sortedStores = [...stores].sort((left, right) => left.name.localeCompare(right.name, "ko"));
  $(panelConfig.countId).textContent = `${sortedStores.length.toLocaleString("ko-KR")}개 업소`;
  $(panelConfig.storeBodyId).innerHTML = sortedStores.map((store, index) => `<tr>
    <td class="seq">${index + 1}</td>
    <td>${escapeHtml([store.name, store.branch].filter(Boolean).join(" "))}</td>
    <td>${escapeHtml(store.smallName || store.middleName || store.largeName || "미분류")}</td>
    <td>${escapeHtml(store.address || store.lotAddress || "-")}</td>
  </tr>`).join("");
  $(panelConfig.statsId).hidden = true;
  if (sortedStores.length >= 5) renderStoreIndustryChart(sortedStores, panelConfig);
  $(panelConfig.panelId).hidden = false;
  $(panelConfig.bodyId).scrollTop = 0;
}

function renderClusterPanel(stores) {
  renderStorePanel(stores, MARKET_STORE_PANEL);
}

function renderOutlinePanel(stores) {
  renderStorePanel(stores, OUTLINE_STORE_PANEL);
}

function setOutlineState(message, isError = false) {
  const state = $("outlineState");
  if (!state) return;
  state.hidden = false;
  state.classList.toggle("is-error", isError);
  state.textContent = message;
}

function clearOutlineLayers() {
  closeOutlinePanel();
  clearOutlineStatistics();
  clearZoneClosure();
  outlineGroundLayer?.remove();
  outlineRoadLayer?.remove();
  outlineBuildingLayer?.remove();
  outlineAreaOverlay?.remove();
  outlineAreaMarker?.remove();
  outlineAreaOverlay = null;
  outlineAreaMarker = null;
  outlineGroundLayer = null;
  outlineRoadLayer = null;
  outlineBuildingLayer = null;
  outlineFeatures = [];
  outlineRoadFeatures = [];
  outlineIndustryById = new Map();
  outlineStoresById = new Map();
  $("outlineWorkspace").hidden = true;
  $("outlineLegend").replaceChildren();
  $("outlineLegend").hidden = true;
  $("outlineZoneName").textContent = "선택 상권";
  $("outlineZoneMeta").textContent = "";
  const state = $("outlineState");
  state.hidden = true;
  state.classList.remove("is-error");
  state.textContent = "";
  if (outlineMap) {
    outlineMap.setMaxBounds(null);
    outlineMap.setMinZoom(OUTLINE_MAP_MIN_ZOOM);
    outlineMap.setMaxZoom(OUTLINE_MAP_MAX_ZOOM);
  }
}

async function loadOutlineManifest() {
  if (outlineManifest) return outlineManifest;
  const response = await fetch(OUTLINE_MANIFEST_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`건물 윤곽 목록을 불러오지 못했습니다. HTTP ${response.status}`);
  const payload = await response.json();
  const cells = Array.isArray(payload.cells)
    ? payload.cells.filter((cell) => cell?.file && Array.isArray(cell.bounds))
    : [];
  if (!cells.length) throw new Error("건물 윤곽 목록에 cell 정보가 없습니다.");
  outlineManifest = { ...payload, cells };
  return outlineManifest;
}

async function loadOutlineCell(cell) {
  if (outlineCellCache.has(cell.id)) return outlineCellCache.get(cell.id);
  const url = new URL(cell.file, new URL(OUTLINE_MANIFEST_URL, document.baseURI));
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`건물 윤곽 cell을 불러오지 못했습니다. HTTP ${response.status}`);
  const payload = await response.json();
  const features = Array.isArray(payload.features) ? payload.features : [];
  outlineCellCache.set(cell.id, features);
  return features;
}

async function loadOutlineRoads() {
  if (outlineRoadFeaturesCache) return outlineRoadFeaturesCache;
  const response = await fetch(OUTLINE_ROADS_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`실폭도로 데이터를 불러오지 못했습니다. HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.meta?.sigunguCode !== "12210" || !Array.isArray(payload.features)) {
    throw new Error("실폭도로 데이터 형식이 올바르지 않습니다.");
  }
  outlineRoadFeaturesCache = payload.features;
  return outlineRoadFeaturesCache;
}

function outlineFeatureStyle(feature) {
  const industry = outlineIndustryById.get(String(feature.id));
  const color = industry ? outlineIndustryColor(industry) : OUTLINE_UNMATCHED_COLOR;
  return {
    color: industry ? color : "#8490aa",
    weight: industry ? 1.15 : .7,
    opacity: .92,
    fillColor: color,
    fillOpacity: industry ? .78 : .12
  };
}

function bindOutlineFeature(feature, layer) {
  const stores = outlineStoresById.get(String(feature.id)) || [];
  if (!stores.length) return;
  layer.on({
    click(event) {
      L.DomEvent.stopPropagation(event);
      renderOutlinePanel(stores);
    },
    mouseover() {
      layer.setStyle({
        weight: 2.2,
        fillOpacity: .92
      });
    },
    mouseout() { outlineBuildingLayer?.resetStyle(layer); }
  });
}

function renderOutlineLegend() {
  const legend = $("outlineLegend");
  legend.hidden = false;
  const counts = new Map();
  for (const feature of outlineFeatures) {
    const industry = outlineIndustryById.get(String(feature.id)) || "점포 미연결";
    counts.set(industry, (counts.get(industry) || 0) + 1);
  }
  if (!counts.size) {
    legend.innerHTML = '<p class="summary-empty">표시할 건물 윤곽이 없습니다.</p>';
    return;
  }
  const rows = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ko"))
    .map(([industry, count]) => {
      const color = outlineIndustryColor(industry);
      return `<div class="outline-legend-row">
        <span class="outline-legend-label"><i style="background:${color}"></i>${escapeHtml(industry)}</span>
        <strong>${count.toLocaleString("ko-KR")}동</strong>
      </div>`;
    }).join("");
  legend.innerHTML = `<p class="outline-legend-title">건물별 업종·연결 상태</p>${rows}`;
}

function renderOutlineZoneMeta(zone, stores, matchedStoreIds) {
  const name = zone.properties?.name || "선택 상권";
  const area = Number(zone.properties?.areaSqm || 0);
  $("outlineZoneName").textContent = name;
  $("outlineZoneMeta").textContent = [
    area > 0 ? `경계 ${(area / 1e6).toFixed(3)}㎢` : "",
    `업소 ${stores.length.toLocaleString("ko-KR")}개`,
    `점포 연결 ${matchedStoreIds.size.toLocaleString("ko-KR")}개`
  ].filter(Boolean).join(" · ");
}

// 주요상권(기본)·주소 반경(customAreaFeature)·행정동(dongName) 세 가지 뷰가 같은
// 파이프라인(셀 로딩 → 건물 필터 → 업종 연결 → 통계)을 탄다.
async function loadBuildingOutline(view = null) {
  const isArea = view?.mode === "area";
  const isDong = view?.mode === "dong";
  const dongName = isDong ? view.adminDong : "";
  const zone = isArea ? view.feature : selectedZone();
  const requestId = ++outlineLoadId;
  clearOutlineLayers();
  if ((!zone && !isDong) || !outlineMap) {
    if (!zone && outlineMap) setOutlineState("주요상권을 선택해 주세요.");
    return;
  }
  if (isDong && !dongLegalCodes.get(dongName)?.size) {
    setOutlineState(`${dongName}의 법정동 코드를 스냅샷에서 찾을 수 없습니다.`, true);
    return;
  }

  const zoneName = isDong ? dongName : zone.properties?.name || "선택 상권";
  $("outlineZoneName").textContent = zoneName;
  $("outlineZoneMeta").textContent = "건물 윤곽을 불러오는 중입니다.";
  setOutlineState(`${zoneName}의 건물 윤곽을 불러오는 중입니다.`);
  try {
    // 행정동은 경계 자료가 없으므로, 행정동 안 업소들의 좌표 범위를 조금 넓혀
    // 셀·도로를 고르고 건물은 PNU 법정동코드로 가린다.
    const dongStores = isDong ? filterStores(allStores, { adminDong: dongName }) : [];
    const dongStoreBounds = isDong
      ? expandBoundsMeters(rowsBounds(dongStores), 150)
      : null;
    const zoneBounds = isDong ? dongStoreBounds : geometryBounds(zone.geometry);
    if (!zoneBounds) throw new Error("선택 상권의 경계를 읽을 수 없습니다.");
    const manifest = await loadOutlineManifest();
    const cells = manifest.cells.filter((cell) => boundsIntersect(cell.bounds, zoneBounds));
    const [cellFeatures, roadFeatures] = await Promise.all([
      Promise.all(cells.map((cell) => loadOutlineCell(cell))),
      loadOutlineRoads().catch((error) => {
        console.warn("[road-polygons] unavailable", error);
        return [];
      })
    ]);
    if (requestId !== outlineLoadId) return;

    const featureById = new Map();
    cellFeatures.flat().forEach((feature) => {
      const id = String(feature?.id || feature?.properties?.id || "");
      if (id && !featureById.has(id)) featureById.set(id, feature);
    });
    const allBuildings = [...featureById.values()];
    const legalCodes = isDong ? dongLegalCodes.get(dongName) : null;
    outlineFeatures = isDong
      ? allBuildings.filter((feature) => legalCodes.has(String(feature.properties?.pnu ?? "").slice(0, 10)))
      : filterBuildingsInZone(allBuildings, zone.geometry);
    const stores = isDong
      ? dongStores
      : filterStores(allStores, { zoneGeometry: zone.geometry });
    const industryMatches = matchBuildingIndustries(outlineFeatures, stores);
    outlineIndustryById = industryMatches.byId;
    outlineStoresById = industryMatches.storesById;
    if (isDong) {
      // 행정동 뷰는 선택 행정동 업소가 연결된 건물만 남긴다. 건물엔 행정동 속성이 없고
      // 같은 법정동을 여러 행정동이 나눠 쓰므로(계림1동/2동), PNU 필터만으로는 섞인다.
      outlineFeatures = outlineFeatures.filter((feature) => {
        const featureStores = industryMatches.storesById.get(String(feature.id)) || [];
        return featureStores.some((store) => store.adminDong === dongName);
      });
    }
    const buildingBounds = outlineFeatures.map((feature) => geometryBounds(feature.geometry))
      .reduce((bounds, box) => box ? [
        Math.min(bounds[0], box[0]), Math.min(bounds[1], box[1]),
        Math.max(bounds[2], box[2]), Math.max(bounds[3], box[3])
      ] : bounds, isDong ? dongStoreBounds : zoneBounds);
    const roadClipBounds = expandBoundsMeters(buildingBounds, OUTLINE_ROAD_CLIP_BUFFER_METERS);
    const clipArea = isDong ? boundsPolygon(buildingBounds) : zone.geometry;
    outlineRoadFeatures = roadFeatures
      .filter((feature) => geometryIntersects(feature.geometry, clipArea))
      .map((feature) => {
        const geometry = clipGeometryToBounds(feature.geometry, roadClipBounds);
        return geometry ? { ...feature, geometry, bbox: geometryBounds(geometry) } : null;
      })
      .filter(Boolean);

    $("outlineWorkspace").hidden = false;
    outlineMap.invalidateSize();
    if (!isDong) {
      outlineGroundLayer = L.geoJSON(zone, {
        interactive: false,
        style: {
          stroke: false,
          fillColor: "#c8ced4",
          fillOpacity: .22
        }
      }).addTo(outlineMap);
    }
    outlineRoadLayer = L.geoJSON({ type: "FeatureCollection", features: outlineRoadFeatures }, {
      interactive: false,
      style: {
        stroke: false,
        fillColor: "#87919a",
        fillOpacity: .42
      }
    }).addTo(outlineMap);
    outlineBuildingLayer = L.geoJSON({ type: "FeatureCollection", features: outlineFeatures }, {
      style: outlineFeatureStyle,
      onEachFeature: bindOutlineFeature
    }).addTo(outlineMap);
    outlineGroundLayer?.bringToBack();

    // 주소 반경 조회면 영역 경계와 중심을 점선으로 덧그린다.
    if (isArea && areaCenter) {
      outlineAreaOverlay = L.geoJSON(zone, {
        interactive: false,
        style: { color: "#1f6feb", weight: 2, dashArray: "6 4", fill: false }
      }).addTo(outlineMap);
      outlineAreaMarker = L.circleMarker([areaCenter.latitude, areaCenter.longitude], {
        radius: 5, color: "#1f6feb", weight: 2, fillColor: "#7db4ff", fillOpacity: 0.9
      }).addTo(outlineMap);
    }

    const leafletBounds = isDong
      ? outlineBuildingLayer.getBounds()
      : outlineGroundLayer.getBounds();
    if (!leafletBounds.isValid()) throw new Error("선택 상권의 지도 경계가 유효하지 않습니다.");
    const movementBounds = L.latLngBounds(
      [roadClipBounds[1], roadClipBounds[0]],
      [roadClipBounds[3], roadClipBounds[2]]
    ).pad(OUTLINE_MAP_BOUNDS_PADDING);
    outlineMap.setMaxBounds(movementBounds);
    const fitZoom = Math.round(outlineMap.getBoundsZoom(leafletBounds, false));
    const minZoom = Math.max(OUTLINE_MAP_MIN_ZOOM, fitZoom - OUTLINE_MAP_ZOOM_MARGIN);
    const maxZoom = Math.max(minZoom, Math.min(OUTLINE_MAP_MAX_ZOOM, fitZoom + OUTLINE_MAP_ZOOM_MARGIN));
    outlineMap.setMinZoom(minZoom);
    outlineMap.setMaxZoom(Math.max(minZoom, maxZoom));
    outlineMap.fitBounds(leafletBounds, { padding: [28, 28], maxZoom });

    renderOutlineZoneMeta(isDong ? { properties: { name: zoneName } } : zone, stores, industryMatches.matchedStoreIds);
    renderOutlineLegend();
    renderOutlineZoneStatistics(stores, zoneName);
    renderZoneClosure(isDong ? { adminDong: dongName, properties: { name: zoneName } } : zone, stores);
    if (outlineFeatures.length) {
      $("outlineState").hidden = true;
    } else {
      setOutlineState("선택 상권에 표시할 건물 윤곽이 없습니다.");
    }
    setTimeout(() => outlineMap.invalidateSize(), 0);
  } catch (error) {
    if (requestId !== outlineLoadId) return;
    clearOutlineLayers();
    setOutlineState(`${error.message} 데이터가 배포되었는지 확인해 주세요.`, true);
  }
}

function initializeBuildingOutline() {
  if (!outlineMap) {
    outlineMap = L.map("buildingOutlineMap", {
      zoomControl: true,
      preferCanvas: true,
      minZoom: OUTLINE_MAP_MIN_ZOOM,
      maxZoom: OUTLINE_MAP_MAX_ZOOM,
      maxBoundsViscosity: 1
    }).setView(DONGGU_CENTER, 14);
    outlineMap.on("click", closeOutlinePanel);
  }
  setTimeout(() => outlineMap.invalidateSize(), 0);
  loadBuildingOutline();
}

function selectedZone() {
  return mainBizZones.find((feature) => feature.properties.no === selectedZoneNo) || null;
}

function activeMarketStores() {
  return allStores;
}

function zoneStyle(feature) {
  const selected = feature.properties.no === selectedZoneNo;
  return {
    color: selected ? "#83b3ff" : "#f2ce68",
    weight: selected ? 3 : 2,
    opacity: selected ? 1 : .82,
    fillColor: selected ? "#5b98ff" : "#f2ce68",
    fillOpacity: selected ? .18 : .06
  };
}

function buildZoneLayer() {
  zoneLayer = L.geoJSON({ type: "FeatureCollection", features: mainBizZones }, {
    style: zoneStyle,
    onEachFeature(feature, layer) {
      const properties = feature.properties;
      zoneLeafletByNo.set(properties.no, layer);
      layer.bindTooltip(properties.name, { sticky: true, direction: "top" });
      layer.on({
        click(event) {
          L.DomEvent.stopPropagation(event.originalEvent);
          selectZone(properties.no, true);
        },
        mouseover() { if (properties.no !== selectedZoneNo) layer.setStyle({ weight: 3, fillOpacity: .12 }); },
        mouseout() { zoneLayer.resetStyle(layer); }
      });
    }
  }).addTo(marketMap);
}

function syncZoneTooltips() {
  zoneLeafletByNo.forEach((layer) => {
    if (!layer.getTooltip()) {
      layer.bindTooltip(layer.feature.properties.name, { sticky: true, direction: "top" });
    }
  });
}

function createOption(value, label) {
  return new Option(label, value);
}

function replaceOptions(select, items, placeholder) {
  const current = select.value;
  select.replaceChildren(createOption("", placeholder), ...items.map((item) => createOption(item.value, item.label)));
  if (items.some((item) => item.value === current)) select.value = current;
}

function populateMarketFilters() {
  const dongs = [...new Set(activeMarketStores().map((store) => store.adminDong).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((name) => ({ value: name, label: name }));
  const zones = mainBizZones.map((feature) => ({
    value: feature.properties.no,
    label: feature.properties.name
  }));
  const industries = [...activeMarketStores().reduce((items, store) => {
    if (store.largeCode && store.largeName) items.set(store.largeCode, store.largeName);
    return items;
  }, new Map())]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "ko"));
  replaceOptions($("dongFilter"), dongs, "전체 행정동");
  replaceOptions($("zoneFilter"), zones, "전체 지역");
  replaceOptions($("marketTableDongFilter"), dongs, "전체 행정동");
  replaceOptions($("marketTableIndustryFilter"), industries, "전체 업종");
  replaceOptions($("marketTableZoneFilter"), zones, "전체 주요상권");
  replaceOptions($("outlineZoneFilter"), zones, "주요상권 선택");
  replaceOptions($("outlineDongFilter"), dongs, "행정동 선택");
  $("outlineZoneFilter").value = selectedZoneNo;
  $("zoneFilter").disabled = !mainBizZones.length;
  $("marketTableZoneFilter").disabled = !mainBizZones.length;
  $("outlineZoneFilter").disabled = !mainBizZones.length;
  $("outlineDongFilter").disabled = !dongs.length;
}

function marketTableCriteria() {
  const zoneNo = $("marketTableZoneFilter").value;
  const zone = mainBizZones.find((feature) => feature.properties.no === zoneNo);
  return {
    storeName: $("marketTableNameInput").value.trim(),
    adminDong: $("marketTableDongFilter").value,
    largeCode: $("marketTableIndustryFilter").value,
    zoneGeometry: zone?.geometry || null
  };
}

function marketTableZoneNames(store) {
  return mainBizZones
    .filter((feature) => pointInGeometry(store.longitude, store.latitude, feature.geometry))
    .map((feature) => feature.properties.name)
    .join(", ");
}

function marketTablePageRows() {
  const offset = (marketTablePageNo - 1) * MARKET_TABLE_PAGE_SIZE;
  return marketTableRows.slice(offset, offset + MARKET_TABLE_PAGE_SIZE);
}

function marketTableCriteriaLabel() {
  const storeName = $("marketTableNameInput").value.trim();
  const values = [
    $("marketTableDongFilter").selectedOptions[0]?.textContent,
    $("marketTableIndustryFilter").selectedOptions[0]?.textContent,
    $("marketTableZoneFilter").selectedOptions[0]?.textContent,
    $("marketTableSortSelect").selectedOptions[0]?.textContent
  ].filter((value) => value && !value.startsWith("전체"));
  if (storeName) values.unshift(`업소명 ${storeName}`);
  return values.length ? values.join(" · ") : "전체 업소";
}

function renderMarketTable() {
  const lastPage = Math.max(1, Math.ceil(marketTableRows.length / MARKET_TABLE_PAGE_SIZE));
  marketTablePageNo = Math.min(Math.max(marketTablePageNo, 1), lastPage);
  const offset = (marketTablePageNo - 1) * MARKET_TABLE_PAGE_SIZE;
  const rows = marketTablePageRows();
  $("marketTableCount").textContent = `${marketTableRows.length.toLocaleString("ko-KR")}개 업소`;
  $("marketTableCriteria").textContent = `${marketTableAppliedLabel || "전체 업소"} · ${marketTableRows.length.toLocaleString("ko-KR")}개`;
  $("marketTableBody").innerHTML = rows.length ? rows.map((store, index) => `<tr>
    <td class="seq">${offset + index + 1}</td>
    <td>${escapeHtml([store.name, store.branch].filter(Boolean).join(" "))}</td>
    <td>${escapeHtml(store.largeName || "-")}</td>
    <td>${escapeHtml(store.middleName || "-")}</td>
    <td>${escapeHtml(store.smallName || "-")}</td>
    <td>${escapeHtml(store.adminDong || "-")}</td>
    <td>${escapeHtml(marketTableZoneNames(store) || "-")}</td>
    <td>${escapeHtml(store.address || "-")}</td>
  </tr>`).join("") : '<tr class="empty-row"><td colspan="8">조건에 맞는 업소가 없습니다.</td></tr>';
  $("marketTablePageLabel").textContent = `${marketTablePageNo} / ${lastPage}`;
  $("marketTablePrevBtn").disabled = marketTablePageNo <= 1;
  $("marketTableNextBtn").disabled = marketTablePageNo >= lastPage;
  $("marketTableDownloadBtn").disabled = !marketTableRows.length;
  $("marketTableResult").hidden = false;
}

function runMarketTableSearch() {
  if (!allStores.length) {
    showToast("상가정보를 불러온 뒤 다시 조회해 주세요.");
    return;
  }
  marketTableRows = sortStores(
    filterStores(activeMarketStores(), marketTableCriteria()),
    $("marketTableSortSelect").value
  );
  marketTablePageNo = 1;
  marketTableAppliedLabel = marketTableCriteriaLabel();
  renderMarketTable();
}

function clearMarketTableSearch() {
  $("marketTableNameInput").value = "";
  $("marketTableDongFilter").value = "";
  $("marketTableIndustryFilter").value = "";
  $("marketTableZoneFilter").value = "";
  $("marketTableSortSelect").value = "name-asc";
  marketTableRows = [];
  marketTablePageNo = 1;
  marketTableAppliedLabel = "";
  $("marketTableCount").textContent = "0개 업소";
  $("marketTableDownloadBtn").disabled = true;
  $("marketTableResult").hidden = true;
}

function currentMarketFilters() {
  const zone = selectedZone();
  return buildLocationFilter($("dongFilter").value, zone?.geometry || null);
}

function buildStoreMarkers() {
  const icon = L.divIcon({ className: "store-dot", iconSize: [12, 12] });
  storeMarkers = activeMarketStores().map((store) => {
    const marker = L.marker([store.latitude, store.longitude], { icon, title: store.name });
    marker.store = store;
    marker.bindPopup(`<div class="store-popup"><strong>${escapeHtml(store.name)}${store.branch ? ` ${escapeHtml(store.branch)}` : ""}</strong><span>${escapeHtml(store.smallName || store.largeName)}</span><span>${escapeHtml(store.address)}</span></div>`);
    marker.on({
      click: closeClusterPanel,
      mouseover() { if (selectedZoneNo || $("dongFilter").value) marker.openPopup(); },
      mouseout() { if (selectedZoneNo || $("dongFilter").value) marker.closePopup(); }
    });
    return marker;
  });
}

function applyMarketFilters() {
  closeClusterPanel();
  visibleStores = filterStores(activeMarketStores(), currentMarketFilters());
  markerCluster.clearLayers();
  if ($("dongFilter").value || selectedZoneNo) {
    const visibleIds = new Set(visibleStores.map((store) => store.id));
    markerCluster.addLayers(storeMarkers.filter((marker) => visibleIds.has(marker.store.id)));
  }
  renderSelectionOverview();
}

function summaryRows(counts, total, limit = 6, emptyLabel = "업소") {
  if (!counts.length) return `<p class="summary-empty">조건에 맞는 ${emptyLabel}가 없습니다.</p>`;
  const max = counts[0].count || 1;
  return counts.slice(0, limit).map(({ name, count }) => `<div class="summary-row">
    <div class="summary-label"><span>${escapeHtml(name)}</span><strong>${count.toLocaleString("ko-KR")}</strong></div>
    <div class="summary-track" title="전체의 ${total ? Math.round(count / total * 100) : 0}%"><span style="width:${Math.round(count / max * 100)}%"></span></div>
  </div>`).join("");
}

function renderSelectionOverview() {
  const zone = selectedZone();
  const adminDong = $("dongFilter").value;
  const entityLabel = "업소";
  if (!zone && !adminDong) {
    $("selectionOverview").innerHTML = `<p>행정동 또는 주요상권을 선택하면 ${entityLabel} 수와 상위 업종 소분류를 확인할 수 있습니다.</p>`;
    return;
  }
  const name = zone?.properties?.name || adminDong;
  const area = zone ? Number(zone.properties.areaSqm || 0) / 1e6 : null;
  const countLabel = "업소 수";
  $("selectionOverview").innerHTML = `<p class="selection-name">${escapeHtml(name)}</p>
    <dl>
      ${area === null ? "" : `<div><dt>경계 면적</dt><dd>${area.toFixed(3)}㎢</dd></div>`}
      <div><dt>${countLabel}</dt><dd>${visibleStores.length.toLocaleString("ko-KR")}개</dd></div>
    </dl>
    <p class="selection-category-title">상위 업종 소분류 10개</p>
    <div class="selection-categories">${summaryRows(countBy(visibleStores, "smallName"), visibleStores.length, 10, entityLabel)}</div>`;
}

function selectZone(number, fitBounds) {
  const selection = buildLocationSelection("zone", number);
  selectedZoneNo = selection.zoneNo;
  $("zoneFilter").value = selectedZoneNo;
  $("outlineZoneFilter").value = selectedZoneNo;
  $("outlineDongFilter").value = "";
  $("dongFilter").value = selection.adminDong;
  syncZoneTooltips();
  zoneLayer?.setStyle(zoneStyle);
  applyMarketFilters();
  const layer = zoneLeafletByNo.get(selectedZoneNo);
  if (fitBounds && layer && !$("market-view-map").hidden) marketMap.fitBounds(layer.getBounds(), { padding: [32, 32], maxZoom: 16 });
  if (outlineMap) loadBuildingOutline();
}

$("dongFilter").addEventListener("change", (event) => {
  $("outlineDongFilter").value = "";
  const selection = buildLocationSelection("dong", event.target.value);
  selectedZoneNo = selection.zoneNo;
  $("zoneFilter").value = selection.zoneNo;
  $("outlineZoneFilter").value = selection.zoneNo;
  syncZoneTooltips();
  zoneLayer?.setStyle(zoneStyle);
  applyMarketFilters();
  if (event.target.value && visibleStores.length) {
    const bounds = L.latLngBounds(visibleStores.map((store) => [store.latitude, store.longitude]));
    marketMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
  } else if (!event.target.value) {
    marketMap.setView(DONGGU_CENTER, 14);
  }
  if (outlineMap) loadBuildingOutline();
});
$("zoneFilter").addEventListener("change", (event) => selectZone(event.target.value, Boolean(event.target.value)));
$("outlineZoneFilter").addEventListener("change", (event) => {
  customAreaFeature = null;
  $("outlineDongFilter").value = "";
  selectZone(event.target.value, Boolean(event.target.value));
});
$("outlineDongFilter").addEventListener("change", (event) => {
  customAreaFeature = null;
  $("outlineZoneFilter").value = "";
  const dong = event.target.value;
  if (!dong) {
    loadBuildingOutline();
    return;
  }
  loadBuildingOutline({ mode: "dong", adminDong: dong });
});
$("resetMarketBtn").addEventListener("click", () => {
  $("dongFilter").value = "";
  selectZone("", false);
  marketMap?.setView(DONGGU_CENTER, 14);
});
$("clusterPanelClose").addEventListener("click", closeClusterPanel);
$("outlinePanelClose").addEventListener("click", closeOutlinePanel);
$("marketTableRunBtn").addEventListener("click", runMarketTableSearch);
$("marketTableNameInput").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  runMarketTableSearch();
});
$("marketTableClearBtn").addEventListener("click", clearMarketTableSearch);
$("marketTablePrevBtn").addEventListener("click", () => {
  marketTablePageNo -= 1;
  renderMarketTable();
});
$("marketTableNextBtn").addEventListener("click", () => {
  marketTablePageNo += 1;
  renderMarketTable();
});
$("marketTableDownloadBtn").addEventListener("click", () => {
  if (!marketTableRows.length) return;
  downloadXlsx(
    ["순번", "업소명", "지점명", "업종 대분류", "업종 중분류", "업종 소분류", "행정동", "주요상권", "도로명주소"],
    marketTableRows.map((store, index) => [
      index + 1,
      store.name,
      store.branch,
      store.largeName,
      store.middleName,
      store.smallName,
      store.adminDong,
      marketTableZoneNames(store),
      store.address
    ]),
    `소상공인조회_${new Date().toISOString().slice(0, 10)}.xlsx`,
    "업소"
  );
});
// Closure statistics
// 통계 탭은 조건 없이 스냅샷 전체를 그린다. 아래에 다른 주제 통계가 같은 형태로 덧붙는다.
const CLOSURE_SNAPSHOT_URL = "data/closed_licenses_donggu.json";
const STATS_BAR_LIMIT = 14;
const STATS_LIFESPAN_MIN_SAMPLE = 5;
const CHART_MARK_COLOR = "var(--accent)";
// 한 그래프에 두 계열이 설 때만 쓰는 둘째 색. 강조색과 색각 이상에서도 구분된다(ΔE 17 이상).
const CHART_ALT_MARK_COLOR = "var(--yellow)";
let closureSnapshotPromise = null;
let statsReady = false;
let closureMeta = null;
let closureLicenses = [];

async function loadClosureSnapshot() {
  if (!closureSnapshotPromise) {
    closureSnapshotPromise = (async () => {
      const response = await fetch(CLOSURE_SNAPSHOT_URL, { cache: "no-cache" });
      if (!response.ok) throw new Error(`폐업·휴업 자료를 불러오지 못했습니다. HTTP ${response.status}`);
      const payload = await response.json();
      closureMeta = payload.meta || {};
      closureLicenses = Array.isArray(payload.licenses) ? payload.licenses : [];
      if (!closureLicenses.length) throw new Error("폐업·휴업 자료에 표시할 기록이 없습니다.");
      return closureLicenses;
    })().catch((error) => {
      closureSnapshotPromise = null;
      throw error;
    });
  }
  return closureSnapshotPromise;
}

async function initializeStats() {
  if (statsReady) return;
  try {
    await loadClosureSnapshot();
    // 폐업률의 분모인 영업 중 상가는 상가·상권 조회가 읽어 둔다. 통계 탭을 먼저 열어도 채워지게 한다.
    initializeMarket();
    statsReady = true;
    renderStatsMeta();
    $("statsState").hidden = true;
    $("statsWorkspace").hidden = false;
    renderStats();
  } catch (error) {
    // 화면을 이미 열어 둔 뒤 실패하면 안내가 숨은 요소에 갇힌다. 다시 드러내고 작업면을 감춘다.
    statsReady = false;
    $("statsWorkspace").hidden = true;
    $("statsState").hidden = false;
    $("statsState").classList.add("is-error");
    $("statsState").textContent = `${error.message} npm run update-closed-licenses를 먼저 실행해 주세요.`;
    return;
  }
}

$("statsTrendScope").addEventListener("change", () => renderStats());

function renderStatsMeta() {
  const generated = closureMeta.generatedAt
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" }).format(new Date(closureMeta.generatedAt))
    : "미확인";
  $("statsMeta").textContent = `${[
    closureMeta.source || "행정안전부 지방행정 인허가 데이터(폐업·휴업)",
    `${closureMeta.sinceYear}년 이후 폐업 ${Number(closureMeta.totalCount || 0).toLocaleString("ko-KR")}건`,
    `갱신일 ${generated}`
  ].filter(Boolean).join(" · ")} · 폐업률은 출처가 다른 영업 중 상가와 폐업 기록을 합쳐 분모로 삼고 행정동 미확정 건은 빼므로, 실제 비율은 이보다 낮으며 순위 비교용으로만 보세요.`;
}

function renderStats() {
  if (!statsReady) return;
  populateStatsTrendScope();
  const rows = filterClosureRows(closureLicenses, { statusKind: "closed" });
  // 막대 그래프는 기간이 축에 드러나지 않으니, 툴팁이 어느 기간의 폐업인지 함께 말한다.
  const period = closurePeriodLabel(rows);
  renderStatsTrend(statsTrendRows(rows));
  renderStatsRateCharts(rows, period);
  renderStatsLifespanCharts(rows, period);
}

// 연도별 폐업은 선택 범위(행정동·주요상권)에 맞춰 가린다. 아래 네 개 차트는 동구 전체 기준을 유지한다.
function statsTrendRows(rows) {
  const scope = $("statsTrendScope")?.value || "";
  if (!scope) return rows;
  if (scope.startsWith("zone:")) {
    const zone = mainBizZones.find((feature) => `zone:${feature.properties.no}` === scope);
    return zone ? closuresInZone(rows, zone.geometry).rows : [];
  }
  return rows.filter((row) => row.adminDong === scope);
}

function populateStatsTrendScope() {
  const select = $("statsTrendScope");
  if (!select) return;
  const current = select.value;
  const dongGroup = document.createElement("optgroup");
  dongGroup.label = "행정동";
  for (const name of DONGGU_ADMIN_DONGS) dongGroup.append(new Option(name, name));
  const zoneGroup = document.createElement("optgroup");
  zoneGroup.label = "주요상권";
  for (const zone of mainBizZones) zoneGroup.append(new Option(zone.properties.name, `zone:${zone.properties.no}`));
  select.replaceChildren(new Option("동구 전체", ""), dongGroup, zoneGroup);
  select.value = current;
}

function closurePeriodLabel(rows) {
  const years = closureYearCounts(rows);
  if (!years.length) return "";
  const first = years[0].year;
  const last = years[years.length - 1].year;
  return first === last ? `${first}년` : `${first}~${last}년`;
}

function renderStatsTrend(rows) {
  const scopeLabel = $("statsTrendScope")?.selectedOptions?.[0]?.textContent || "";
  $("statsTrendTitle").textContent = scopeLabel && scopeLabel !== "동구 전체" ? `연도별 폐업 · ${scopeLabel}` : "연도별 폐업";
  const years = closureYearCounts(rows);
  drawLineChart($("statsTrendChart"), {
    points: years.map(({ year, count }) => ({ label: `${year}년`, value: count })),
    valueLabel: "폐업",
    format: (value) => `${value.toLocaleString("ko-KR")}건`,
    emptyText: "폐업 기록이 없습니다."
  });
  fillTableRows($("statsTrendTable"), years.map(({ year, count }) => [`${year}년`, count.toLocaleString("ko-KR")]), 2);
}

function renderStatsRateCharts(rows, period = "") {
  for (const [keyFn, chartId] of [
    [(row) => row.adminDong, "statsDongRateChart"],
    [(row) => row.largeName, "statsIndustryRateChart"]
  ]) {
    const table = closureRateTableWithLifespan(allStores, rows, keyFn);
    const ranked = table.rows
      .filter((row) => row.closedCount > 0 && row.activeCount > 0)
      .sort((left, right) => right.closureRate - left.closureRate)
      .slice(0, STATS_BAR_LIMIT);
    drawBarChart($(chartId), {
      rows: ranked.map((row) => ({ label: row.name, value: row.closureRate * 100 })),
      format: (value) => `${value.toFixed(1)}%`,
      tooltip: (row, index) => `${period ? `${period} ` : ""}폐업 ${ranked[index].closedCount.toLocaleString("ko-KR")}건`,
      valueLabel: "폐업률",
      emptyText: "비율을 낼 수 있는 폐업 기록이 없습니다."
    });
  }
}

function renderStatsLifespanCharts(rows, period = "") {
  for (const [keyFn, chartId] of [
    [(row) => row.adminDong, "statsDongLifespanChart"],
    [(row) => row.largeName, "statsIndustryLifespanChart"]
  ]) {
    const table = closureRateTableWithLifespan([], rows, keyFn);
    const ranked = table.rows
      .filter((row) => Number.isFinite(row.medianLifespanDays) && row.closedCount >= STATS_LIFESPAN_MIN_SAMPLE)
      .sort((left, right) => right.medianLifespanDays - left.medianLifespanDays)
      .slice(0, STATS_BAR_LIMIT);
    drawBarChart($(chartId), {
      rows: ranked.map((row) => ({ label: row.name, value: row.medianLifespanDays / 365 })),
      format: (value) => `${value.toFixed(1)}년`,
      tooltip: (row, index) => `${period ? `${period} ` : ""}폐업 ${ranked[index].closedCount.toLocaleString("ko-KR")}건 기준`,
      valueLabel: "영업기간 중앙값",
      emptyText: "중앙값을 낼 수 있는 폐업 기록이 없습니다."
    });
  }
}

function fillTableRows(tbody, rows, columnCount) {
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${columnCount}">표시할 기록이 없습니다.</td></tr>`;
    return;
  }
  tbody.replaceChildren(...rows.map((cells) => {
    const tr = document.createElement("tr");
    cells.forEach((cell, index) => {
      const td = document.createElement("td");
      if (index) td.className = "mono";
      td.textContent = cell;
      tr.appendChild(td);
    });
    return tr;
  }));
}

const COMBO_CHART = { width: 760, height: 260, left: 46, right: 46, top: 18, bottom: 38 };

// 건수(막대)와 비율(선)은 단위가 달라 축을 나눠 세운다. 눈금 색을 계열 색에 맞추고
// 범례를 붙여, 어느 축이 어느 계열의 것인지 색으로만 헷갈리지 않게 한다.
function drawComboChart(plot, { categories, bars, line, emptyText }) {
  if (!categories.length) return renderEmptyChart(plot, emptyText);
  const { width, height, left, right, top, bottom } = COMBO_CHART;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const barAxis = axisTicks(Math.max(...bars.values.filter(Number.isFinite), 0));
  const lineAxis = axisTicks(Math.max(...line.values.filter(Number.isFinite), 0));
  const bands = columnBands(categories.length, { width: plotWidth });
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "chart-svg",
    role: "img",
    "aria-label": `연도별 ${bars.label}과 ${line.label}. 값은 아래 표로 보기에서 확인할 수 있습니다.`
  });

  for (const tick of barAxis.ticks) {
    const y = top + plotHeight - tick / barAxis.max * plotHeight;
    svg.appendChild(svgElement("line", { x1: left, x2: width - right, y1: y, y2: y, class: "chart-grid-line" }));
    const text = svgElement("text", { x: left - 10, y: y + 4, class: "chart-axis-text", "text-anchor": "end" });
    text.textContent = tick.toLocaleString("ko-KR");
    svg.appendChild(text);
  }
  for (const tick of lineAxis.ticks) {
    const y = top + plotHeight - tick / lineAxis.max * plotHeight;
    const text = svgElement("text", {
      x: width - right + 10, y: y + 4, class: "chart-axis-text chart-axis-text-alt", "text-anchor": "start"
    });
    text.textContent = line.format(tick);
    svg.appendChild(text);
  }

  bars.values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const barHeight = barWidth(value, { width: plotHeight, max: barAxis.max });
    svg.appendChild(svgElement("rect", {
      x: left + bands[index].x,
      y: top + plotHeight - barHeight,
      width: bands[index].width,
      height: Math.max(barHeight, value > 0 ? 1 : 0),
      rx: barCornerRadius(bands[index].width, barHeight),
      class: "chart-bar",
      fill: CHART_MARK_COLOR
    }));
  });

  // 비율이 없는 해에서는 선을 끊는다. 이어 버리면 없는 값을 지어낸 셈이 된다.
  const lineCoords = line.values.map((value, index) => Number.isFinite(value)
    ? {
      x: left + bands[index].center,
      y: top + plotHeight - value / lineAxis.max * plotHeight
    }
    : null);
  const drawn = lineCoords.filter(Boolean);
  if (drawn.length) {
    svg.appendChild(svgElement("path", { d: linePath(drawn), class: "chart-line", stroke: CHART_ALT_MARK_COLOR }));
    drawn.forEach(({ x, y }) => {
      svg.appendChild(svgElement("circle", { cx: x, cy: y, r: 4, class: "chart-dot", fill: CHART_ALT_MARK_COLOR }));
    });
  }

  const labelEvery = Math.ceil(categories.length / 12);
  categories.forEach((label, index) => {
    if (index % labelEvery && index !== categories.length - 1) return;
    const text = svgElement("text", {
      x: left + bands[index].center, y: height - 14, class: "chart-axis-text", "text-anchor": "middle"
    });
    text.textContent = label;
    svg.appendChild(text);
  });

  const crosshair = svgElement("line", { class: "chart-crosshair", y1: top, y2: top + plotHeight, x1: 0, x2: 0 });
  crosshair.style.opacity = "0";
  svg.appendChild(crosshair);

  const band = plotWidth / categories.length;
  categories.forEach((label, index) => {
    const barText = Number.isFinite(bars.values[index]) ? bars.format(bars.values[index]) : "기록 없음";
    const lineText = Number.isFinite(line.values[index]) ? line.format(line.values[index]) : "";
    const hit = svgElement("rect", {
      x: left + index * band, y: top, width: band, height: plotHeight,
      class: "chart-hit", tabindex: "0", role: "button",
      "aria-label": [label, `${bars.label} ${barText}`, lineText && `${line.label} ${lineText}`].filter(Boolean).join(" ")
    });
    const activate = () => {
      crosshair.style.opacity = "1";
      crosshair.setAttribute("x1", String(left + bands[index].center));
      crosshair.setAttribute("x2", String(left + bands[index].center));
      const box = plot.getBoundingClientRect();
      const scale = box.width / width;
      showChartTooltip(plot, {
        title: label,
        value: `${bars.label} ${barText}`,
        detail: lineText ? `${line.label} ${lineText}` : "",
        x: (left + bands[index].center) * scale,
        y: top * scale
      });
    };
    hit.addEventListener("pointerenter", activate);
    hit.addEventListener("focus", activate);
    hit.addEventListener("pointerleave", () => { crosshair.style.opacity = "0"; hideChartTooltip(plot); });
    hit.addEventListener("blur", () => { crosshair.style.opacity = "0"; hideChartTooltip(plot); });
    svg.appendChild(hit);
  });

  plot.replaceChildren(svg);
}

// 막대는 끝에 값을 직접 적고 연도 추이는 표를 함께 둔다. 말풍선은 세부 수치를 덧붙일 뿐 값을 가두지 않는다.
function chartTooltip(plot) {
  let tooltip = plot.querySelector(".chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    plot.appendChild(tooltip);
  }
  return tooltip;
}

function showChartTooltip(plot, { title, value, detail, x, y }) {
  const tooltip = chartTooltip(plot);
  tooltip.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = value;
  const label = document.createElement("span");
  label.textContent = title;
  tooltip.append(strong, label);
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    tooltip.appendChild(small);
  }
  tooltip.hidden = false;
  const bounds = plot.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  tooltip.style.left = `${Math.max(4, Math.min(x - width / 2, bounds.width - width - 4))}px`;
  tooltip.style.top = `${Math.max(4, y - tooltip.offsetHeight - 12)}px`;
}

function hideChartTooltip(plot) {
  const tooltip = plot.querySelector(".chart-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function renderEmptyChart(plot, text) {
  plot.replaceChildren();
  const message = document.createElement("p");
  message.className = "summary-empty";
  message.textContent = text;
  plot.appendChild(message);
}

const LINE_CHART = { width: 760, height: 250, left: 54, right: 20, top: 16, bottom: 34 };

function drawLineChart(plot, { points, valueLabel, format, emptyText }) {
  if (!points.length) return renderEmptyChart(plot, emptyText);
  const { width, height, left, right, top, bottom } = LINE_CHART;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const { max, ticks } = axisTicks(Math.max(...points.map(({ value }) => value)));
  const coords = linePoints(points.map(({ value }) => value), { width: plotWidth, height: plotHeight, max });
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "chart-svg",
    role: "img",
    "aria-label": `${valueLabel} 연도별 추이. 값은 아래 표로 보기에서 확인할 수 있습니다.`
  });

  for (const tick of ticks) {
    const y = top + plotHeight - tick / max * plotHeight;
    svg.appendChild(svgElement("line", { x1: left, x2: width - right, y1: y, y2: y, class: "chart-grid-line" }));
    const text = svgElement("text", { x: left - 10, y: y + 4, class: "chart-axis-text", "text-anchor": "end" });
    text.textContent = tick.toLocaleString("ko-KR");
    svg.appendChild(text);
  }

  const path = svgElement("path", {
    d: linePath(coords.map(({ x, y }) => ({ x: x + left, y: y + top }))),
    class: "chart-line",
    stroke: CHART_MARK_COLOR
  });
  svg.appendChild(path);

  const labelEvery = Math.ceil(points.length / 12);
  points.forEach((point, index) => {
    const { x, y } = coords[index];
    if (index % labelEvery === 0 || index === points.length - 1) {
      const text = svgElement("text", { x: x + left, y: height - 12, class: "chart-axis-text", "text-anchor": "middle" });
      text.textContent = point.label;
      svg.appendChild(text);
    }
    svg.appendChild(svgElement("circle", { cx: x + left, cy: y + top, r: 4, class: "chart-dot", fill: CHART_MARK_COLOR }));
  });

  // 마지막 값만 직접 적는다. 모든 점에 숫자를 붙이면 읽히지 않는다.
  const last = coords.at(-1);
  const endLabel = svgElement("text", {
    x: Math.min(last.x + left, width - right),
    y: Math.max(top + 12, last.y + top - 12),
    class: "chart-value-text",
    "text-anchor": "end"
  });
  endLabel.textContent = format(points.at(-1).value);
  svg.appendChild(endLabel);

  const crosshair = svgElement("line", { class: "chart-crosshair", y1: top, y2: top + plotHeight, x1: 0, x2: 0 });
  crosshair.style.opacity = "0";
  svg.appendChild(crosshair);

  points.forEach((point, index) => {
    const band = plotWidth / Math.max(1, points.length - 1 || 1);
    const hit = svgElement("rect", {
      x: coords[index].x + left - band / 2,
      y: top,
      width: band,
      height: plotHeight,
      class: "chart-hit",
      tabindex: "0",
      role: "button",
      "aria-label": `${point.label} ${format(point.value)}`
    });
    const activate = () => {
      crosshair.style.opacity = "1";
      crosshair.setAttribute("x1", String(coords[index].x + left));
      crosshair.setAttribute("x2", String(coords[index].x + left));
      const box = plot.getBoundingClientRect();
      const scale = box.width / width;
      showChartTooltip(plot, {
        title: point.label,
        value: format(point.value),
        x: (coords[index].x + left) * scale,
        y: (coords[index].y + top) * scale
      });
    };
    hit.addEventListener("pointerenter", activate);
    hit.addEventListener("focus", activate);
    hit.addEventListener("pointerleave", () => { crosshair.style.opacity = "0"; hideChartTooltip(plot); });
    hit.addEventListener("blur", () => { crosshair.style.opacity = "0"; hideChartTooltip(plot); });
    svg.appendChild(hit);
  });

  plot.replaceChildren(svg);
}

const BAR_CHART = { width: 480, labelWidth: 86, valueWidth: 56, band: 30, top: 6, bottom: 6 };

function drawBarChart(plot, { rows, format, tooltip, valueLabel, emptyText }) {
  if (!rows.length) return renderEmptyChart(plot, emptyText);
  const { width, labelWidth, valueWidth, band, top, bottom } = BAR_CHART;
  const plotWidth = width - labelWidth - valueWidth;
  const plotHeight = rows.length * band;
  const height = plotHeight + top + bottom;
  const { max } = axisTicks(Math.max(...rows.map(({ value }) => value)));
  const bands = barBands(rows.length, { height: plotHeight });
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "chart-svg",
    role: "img",
    "aria-label": `${valueLabel} 비교. 값은 아래 표로 보기에서 확인할 수 있습니다.`
  });
  svg.appendChild(svgElement("line", {
    x1: labelWidth, x2: labelWidth, y1: top, y2: top + plotHeight, class: "chart-axis-line"
  }));

  rows.forEach((row, index) => {
    const { y, height: barHeight } = bands[index];
    const rendered = barWidth(row.value, { width: plotWidth, max });
    const label = svgElement("text", {
      x: labelWidth - 10, y: top + y + barHeight / 2 + 4, class: "chart-axis-text", "text-anchor": "end"
    });
    label.textContent = row.label;
    svg.appendChild(label);
    svg.appendChild(svgElement("rect", {
      x: labelWidth,
      y: top + y,
      width: Math.max(rendered, 1),
      height: barHeight,
      rx: barCornerRadius(rendered, barHeight),
      class: "chart-bar",
      fill: CHART_MARK_COLOR
    }));
    const value = svgElement("text", {
      x: labelWidth + rendered + 8, y: top + y + barHeight / 2 + 4, class: "chart-value-text"
    });
    value.textContent = format(row.value);
    svg.appendChild(value);

    const hit = svgElement("rect", {
      x: labelWidth, y: top + index * band, width: plotWidth + valueWidth, height: band,
      class: "chart-hit", tabindex: "0", role: "button",
      "aria-label": `${row.label} ${format(row.value)}`
    });
    const activate = () => {
      const box = plot.getBoundingClientRect();
      const scale = box.width / width;
      showChartTooltip(plot, {
        title: row.label,
        value: format(row.value),
        detail: tooltip ? tooltip(row, index) : "",
        x: (labelWidth + rendered) * scale,
        y: (top + y) * scale
      });
    };
    hit.addEventListener("pointerenter", activate);
    hit.addEventListener("focus", activate);
    hit.addEventListener("pointerleave", () => hideChartTooltip(plot));
    hit.addEventListener("blur", () => hideChartTooltip(plot));
    svg.appendChild(hit);
  });

  plot.replaceChildren(svg);
}

// 주소 반경 조회: 주소를 찾아 원형·정사각형 폴리곤을 만들고, 상권 분석과 같은
// 파이프라인(피겨그라운드 건물 폴리곤 → 업종 연결 → 하단 통계)으로 그린다.
const AREA_MIN_RADIUS = 50;
const AREA_MAX_RADIUS = 5000;
let areaCenter = null;
let customAreaFeature = null;
let outlineAreaOverlay = null;
let outlineAreaMarker = null;

function areaSearchOptions() {
  const shape = $("areaShapeSelect").value === AREA_SHAPES.square ? AREA_SHAPES.square : AREA_SHAPES.circle;
  const radiusM = Math.min(AREA_MAX_RADIUS, Math.max(AREA_MIN_RADIUS, Number($("areaRadiusInput").value) || 0));
  return { shape, radiusM };
}

function clampAreaRadius() {
  const input = $("areaRadiusInput");
  const value = Math.min(AREA_MAX_RADIUS, Math.max(AREA_MIN_RADIUS, Number(input.value) || 0));
  input.value = String(value);
  return value;
}

function areaShapeLabel(options) {
  return options.shape === AREA_SHAPES.square
    ? `한 변 ${Math.round(options.radiusM * 2).toLocaleString("ko-KR")}m 정사각형`
    : `반경 ${options.radiusM.toLocaleString("ko-KR")}m 원형`;
}

// 카카오 지오코딩 프록시를 쓸 수 없으면 스냅샷 주소 가운데서 찾는다.
function localAddressMatch(query) {
  const key = query.replace(/\s+/g, "").toLowerCase();
  if (!key) return null;
  const hits = allStores
    .filter((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude))
    .map((store) => {
      const address = `${store.address || ""} ${store.lotAddress || ""}`.replace(/\s+/g, "").toLowerCase();
      return { store, address };
    })
    .filter(({ address }) => address.includes(key))
    .sort((left, right) => left.address.length - right.address.length);
  const hit = hits[0]?.store;
  return hit ? { latitude: hit.latitude, longitude: hit.longitude, label: hit.address || hit.name, source: "스냅샷 주소 매칭" } : null;
}

async function geocodeAddress(query) {
  try {
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (response.ok) {
      const data = await response.json();
      if (Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
        return { latitude: data.latitude, longitude: data.longitude, label: data.addressName || query, source: "카카오 주소 검색" };
      }
    }
  } catch {
    // 프록시를 못 쓰는 환경(로컬 정적 서버 등)이면 아래 폴백으로 찾는다.
  }
  return localAddressMatch(query);
}

async function runAreaLookup() {
  if (!outlineMap) return;
  const query = $("areaLookupInput").value.trim();
  const status = $("areaLookupStatus");
  if (!query) {
    status.textContent = "주소를 입력하세요. 예: 동구 동계천로 39";
    return;
  }
  clampAreaRadius();
  $("areaLookupBtn").disabled = true;
  status.textContent = "주소를 찾는 중입니다.";
  try {
    const center = await geocodeAddress(query);
    if (!center) {
      status.textContent = "주소를 찾지 못했습니다. 동구 주소로 다시 시도해 주세요.";
      return;
    }
    areaCenter = center;
    const options = areaSearchOptions();
    customAreaFeature = {
      type: "Feature",
      geometry: areaPolygonGeometry(center, options),
      properties: { name: `${query} (${areaShapeLabel(options)})` }
    };
    status.textContent = center.source === "스냅샷 주소 매칭"
      ? "지오코딩 프록시를 못 써 스냅샷 주소에서 찾았습니다."
      : "";
    $("outlineDongFilter").value = "";
    await loadBuildingOutline({ mode: "area", feature: customAreaFeature, center });
  } finally {
    $("areaLookupBtn").disabled = false;
  }
}

$("areaLookupBtn").addEventListener("click", runAreaLookup);
$("areaLookupInput").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  runAreaLookup();
});

// National Pension workplace lookup
// 이 서비스는 광주 동구만 다룬다. 조회도 스냅샷도 같은 지역 하나를 본다.

const NPS_PAGE_SIZE = 100;
const NPS_HISTORY_MAX_POINTS = 24;

let npsRows = [];
let npsSnapshot = null;
let insuranceRows = [];
let npsPageNo = 1;
let npsBusy = false;
let npsDetail = { key: "", seq: "", html: "" };
let npsBusinessStatus = { key: "", state: "idle", data: null, error: "" };
let npsAppliedCriteria = null;
let npsCriteriaDirty = false;
let npsSort = "";

let employmentInsuranceRows = [];
let employmentInsuranceSnapshot = null;
let corporateFinancialsByBusinessNumber = new Map();
let corporateFinancialsMeta = null;
let corporateNumbersByBusinessNumber = new Map();
let corporateNumbersMeta = null;

// 업종 대분류 선택기에서 "업종 미상"을 가리키는 값. 분류표의 대분류 코드와 겹치지 않게 둔다.
const NPS_UNKNOWN_SECTION_VALUE = "unknown";

async function fetchNps(params) {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "" && value != null));
  const response = await fetch(`/api/nps?${search}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (error.detail) console.error("[nps]", error.error, error.detail);
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  const payload = await response.json();
  // 0건일 때 어떤 파라미터 조합으로 물었는지 콘솔에 남긴다. 원인 확인용이다.
  if (payload.meta && !(payload.items || []).length) console.info("[nps] 조회 결과 없음", payload.meta);
  return payload;
}

/** 입력 중인 조건을 조회 실행 시점에 결과에 적용한다. */
function npsCriteria() {
  const section = $("npsSectionSelect").value;
  return {
    query: $("npsNameInput").value.trim(),
    businessNumber: $("npsBusinessNumberInput").value.trim(),
    adminDong: $("npsAdminDongSelect").value,
    includeWithdrawn: $("npsIncludeWithdrawn").checked,
    sectionCode: section === NPS_UNKNOWN_SECTION_VALUE ? "" : section,
    unknownIndustryOnly: section === NPS_UNKNOWN_SECTION_VALUE
  };
}

function filteredNpsRows() {
  const criteria = npsAppliedCriteria || {};
  return insuranceRows.filter((row) => matchesInsuranceWorkplaceCriteria(row, criteria));
}

function sortedNpsRows() {
  return sortInsuranceWorkplaces(filteredNpsRows(), npsSort);
}

function npsPageRows() {
  const rows = sortedNpsRows();
  const offset = (npsPageNo - 1) * NPS_PAGE_SIZE;
  return rows.slice(offset, offset + NPS_PAGE_SIZE);
}

function npsStatusBadge(row) {
  if (!row) return "";
  if (row.statusCode === "1") return '<span class="badge badge-green">국민연금 등록</span>';
  if (row.statusCode === "2") return '<span class="badge badge-gray">국민연금 탈퇴</span>';
  return `<span class="badge badge-gray">국민연금 ${escapeHtml(row.statusName || "상태 미상")}</span>`;
}

function insuranceSourceBadge(row) {
  if (row.source === "combined") return '<span class="badge badge-green">국민연금 + 고용·산재</span>';
  if (row.source === "nps") return '<span class="badge badge-gray">국민연금</span>';
  return '<span class="badge badge-yellow">고용·산재</span>';
}

function insuranceSourceRows(row) {
  return row?.sourceRows?.length ? row.sourceRows : row ? [row] : [];
}

function insuranceCoverageRows(row, kind) {
  const coveredTypes = kind === "employment" ? ["0", "2"] : ["0", "1"];
  return insuranceSourceRows(row).filter((sourceRow) => coveredTypes.includes(sourceRow.insuranceType));
}

function insuranceWorkerCountValues(row, kind) {
  return insuranceCoverageRows(row, kind)
    .map((sourceRow) => sourceRow[kind === "employment" ? "employmentWorkerCount" : "industrialWorkerCount"])
    .filter((value) => typeof value === "number");
}

function insuranceManagementNumbers(row, kind) {
  return [...new Set(insuranceCoverageRows(row, kind)
    .map((sourceRow) => sourceRow.workplaceManagementNumber)
    .filter(Boolean))];
}

function insuranceAddressValues(row) {
  return [...new Set(insuranceSourceRows(row)
    .map((sourceRow) => displayAddress(sourceRow.address))
    .filter(Boolean))];
}

function insurancePostalCodeValues(row) {
  return [...new Set(insuranceSourceRows(row)
    .map((sourceRow) => String(sourceRow.postalCode ?? "").trim())
    .filter(Boolean))];
}

function insuranceAdminDongLabel(row) {
  const values = [...insuranceAdminDongs(row)];
  return values.length ? values.join(" · ") : "미확인";
}

function insuranceWorkerCell(row, kind) {
  const employment = row.employmentInsurance;
  if (!employment) return '<span class="muted">-</span>';
  const entries = insuranceCoverageRows(employment, kind)
    .map((sourceRow) => ({
      sourceRow,
      count: sourceRow[kind === "employment" ? "employmentWorkerCount" : "industrialWorkerCount"]
    }))
    .sort((left, right) => (right.count ?? -1) - (left.count ?? -1));
  if (!entries.length) return '<span class="muted">-</span>';
  return `<div class="insurance-metric">${entries.map(({ sourceRow, count }) => {
    const date = kind === "employment" ? sourceRow.employmentEstablishedDate : sourceRow.industrialEstablishedDate;
    const status = kind === "employment" ? sourceRow.employmentStatus : sourceRow.industrialStatus;
    return `<div class="insurance-metric-item"><strong>${employmentInsuranceCountLabel(count)}</strong><span>${status ? escapeHtml(status) : "사업 구분 미기재"}</span><small>${date ? `성립 ${escapeHtml(formatYmd(date))}` : "성립일자 미기재"}</small></div>`;
  }).join("")}</div>`;
}

function insuranceStatusBadges(row) {
  const statuses = [npsStatusBadge(row.nps)];
  for (const kind of ["employment", "industrial"]) {
    const values = [...new Set(insuranceCoverageRows(row.employmentInsurance, kind)
      .map((sourceRow) => sourceRow[kind === "employment" ? "employmentStatus" : "industrialStatus"])
      .filter(Boolean))];
    statuses.push(...values.map((value) => employmentInsuranceStatusBadge(`${kind === "employment" ? "고용" : "산재"} ${value}`)));
  }
  const visibleStatuses = statuses.filter(Boolean);
  return visibleStatuses.join(" ") || '<span class="badge badge-gray">상태 미제공</span>';
}

function insuranceIndustryCell(row) {
  const nps = row.nps;
  const employment = row.employmentInsurance;
  const supplementarySections = !nps?.sectionCode
    ? [...insuranceIndustrySectionCodes(row)]
      .map((code) => INDUSTRY_SECTIONS.find((section) => section.code === code)?.name)
      .filter(Boolean)
    : [];
  const primaryIndustries = nps?.sectionCode
    ? [nps.sectionName]
    : supplementarySections.length
      ? supplementarySections
      : nps && hasIndustryDetail(nps)
        ? [nps.sectionName || "업종 미상"]
        : [];
  const employmentIndustries = [...new Set(insuranceSourceRows(employment)
    .map((sourceRow) => [sourceRow.employmentIndustryCode11 || sourceRow.employmentIndustryCode, sourceRow.employmentIndustryName11 || sourceRow.employmentIndustryName].filter(Boolean).join(" "))
    .filter(Boolean))];
  if (!primaryIndustries.length && !employmentIndustries.length) return '<span class="muted">-</span>';
  return `<div class="insurance-industry">${primaryIndustries.map((industry) => `<strong>${escapeHtml(industry)}</strong>`).join("")}${employmentIndustries.map((industry) => `<small>${escapeHtml(industry)}</small>`).join("")}</div>`;
}

function renderNpsTable() {
  const rows = npsPageRows();
  const body = $("npsResultBody");
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="12">해당 조건의 결과가 없습니다.</td></tr>';
    return;
  }
  const offset = (npsPageNo - 1) * NPS_PAGE_SIZE;
  body.innerHTML = rows.map((row, index) => {
    const opened = npsDetail.key === row.key;
    // 상세 카드는 표 맨 아래가 아니라 누른 행 바로 아래에 한 줄을 끼워 펼친다.
    const card = opened
      ? `<tr class="detail-row"><td colspan="12"><div class="detail-card">${npsDetail.html}${businessStatusHtml(row)}${corporateFinancialHtml(row)}</div></td></tr>`
      : "";
    const nps = row.nps;
    const employment = row.employmentInsurance;
    const name = nps?.name || employment?.name || "-";
    const businessNumber = employment?.businessRegistrationNumber
      || (nps?.bizNoPrefix ? `${nps.bizNoPrefix}-****` : "-");
    const address = employment?.address || nps?.address || "-";
    const npsSubscribers = typeof nps?.subscriberCount === "number" ? `${nps.subscriberCount.toLocaleString("ko-KR")}명` : "-";
    return `<tr${opened ? ' class="is-open"' : ""}>
    <td class="seq">${offset + index + 1}</td>
    <td>${escapeHtml(name)}</td>
    <td>${insuranceSourceBadge(row)}</td>
    <td class="mono">${escapeHtml(businessNumber)}</td>
    <td>${escapeHtml(displayAddress(address) || "-")}</td>
    <td>${escapeHtml(insuranceAdminDongLabel(row))}</td>
    <td>${insuranceIndustryCell(row)}</td>
    <td class="mono">${escapeHtml(npsSubscribers)}</td>
    <td>${insuranceWorkerCell(row, "employment")}</td>
    <td>${insuranceWorkerCell(row, "industrial")}</td>
    <td>${insuranceStatusBadges(row)}</td>
    <td class="detail-cell"><button class="button button-quiet detail-btn" type="button" data-row-key="${escapeHtml(row.key)}" aria-expanded="${opened}">상세</button></td>
  </tr>${card}`;
  }).join("");
}

function renderNpsPager() {
  const lastPage = Math.max(1, Math.ceil(filteredNpsRows().length / NPS_PAGE_SIZE));
  $("npsPager").hidden = lastPage <= 1;
  $("npsPageLabel").textContent = `${npsPageNo} / ${lastPage}`;
  $("npsPrevBtn").disabled = npsPageNo <= 1 || npsBusy;
  $("npsNextBtn").disabled = npsPageNo >= lastPage || npsBusy;
}

function renderNps() {
  const shown = filteredNpsRows().length;
  $("npsCountBadge").textContent = `${shown.toLocaleString("ko-KR")}개 사업장`;
  $("npsDownloadBtn").disabled = !shown;
  renderNpsTable();
  renderNpsPager();
}

/** 조회 결과는 마지막 실행 조건을 유지하고, 새 조건은 다음 조회 때 적용한다. */
function markNpsCriteriaDirty() {
  npsCriteriaDirty = true;
  renderNpsCriteriaState();
}

function renderNpsCriteriaState() {
  const pending = Boolean(npsAppliedCriteria && npsCriteriaDirty);
  $("npsCriteriaNote").hidden = !pending;
}

function showNpsPage(pageNo) {
  const lastPage = Math.max(1, Math.ceil(filteredNpsRows().length / NPS_PAGE_SIZE));
  npsPageNo = Math.min(Math.max(pageNo, 1), lastPage);
  renderNpsTable();
  renderNpsPager();
}

/**
 * 업종 대분류 목록. 국민연금 분류표의 대분류에 고용·산재 업종도 같은 의미로 매핑하고,
 * 두 자료 모두 업종을 담지 않은 사업장이 갈 "업종 미상"을 한 항목으로 덧붙인다.
 */
function fillNpsSectionOptions() {
  $("npsSectionSelect").innerHTML = ['<option value="">전체</option>',
    ...INDUSTRY_SECTIONS.map(({ code, name }) => `<option value="${code}">${escapeHtml(name)}</option>`),
    `<option value="${NPS_UNKNOWN_SECTION_VALUE}">업종 미상</option>`].join("");
}

function fillNpsAdminDongOptions() {
  $("npsAdminDongSelect").innerHTML = ['<option value="">전체 행정동</option>',
    ...DONGGU_ADMIN_DONGS.map((name) => `<option value="${name}">${name}</option>`)].join("");
}

/**
 * 조회는 미리 받아둔 국민연금·고용·산재보험 스냅샷으로 끝낸다. 국민연금 목록은
 * 상세조회까지 마친 월별 스냅샷을 쓰고, 고용·산재 자료는 연말 원본을 정규화한
 * 스냅샷을 함께 읽는다. 국민연금 API는 상세 카드와 월별 추이에만 쓴다.
 */
const NPS_SNAPSHOT_URL = "data/nps_donggu.json";
const CORPORATE_FINANCIALS_SNAPSHOT_URL = "data/corporate_financials_donggu.json";
const CORPORATE_NUMBERS_SNAPSHOT_URL = "data/corporate_numbers_donggu.json";

async function loadNpsSnapshot() {
  if (npsSnapshot) return npsSnapshot;
  const response = await fetch(NPS_SNAPSHOT_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`사업장 자료를 불러오지 못했습니다. (HTTP ${response.status})`);
  const payload = await response.json();
  npsSnapshot = {
    collectedAt: String(payload.collectedAt ?? ""),
    dataCreatedMonth: String(payload.dataCreatedMonth ?? ""),
    items: (payload.items ?? []).map(hydrateSnapshotWorkplace).filter((workplace) => workplace.name)
  };
  return npsSnapshot;
}

async function loadEmploymentInsuranceSnapshot() {
  if (employmentInsuranceSnapshot) return employmentInsuranceSnapshot;
  const response = await fetch(EMPLOYMENT_INSURANCE_SNAPSHOT_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`고용·산재보험 자료를 불러오지 못했습니다. (HTTP ${response.status})`);
  const payload = await response.json();
  employmentInsuranceSnapshot = {
    meta: payload.meta || {},
    items: mergeEmploymentInsuranceRows((payload.items || []).filter((item) => item.name))
  };
  return employmentInsuranceSnapshot;
}

async function loadCorporateFinancialsSnapshot() {
  if (corporateFinancialsMeta) return;
  try {
    const response = await fetch(CORPORATE_FINANCIALS_SNAPSHOT_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    corporateFinancialsMeta = payload.meta || {};
    corporateFinancialsByBusinessNumber = new Map((payload.companies || [])
      .map((company) => [String(company.businessRegistrationNumber || ""), company])
      .filter(([businessNumber]) => /^\d{10}$/.test(businessNumber)));
  } catch (error) {
    console.error("[corporate-financials] snapshot unavailable", error);
    corporateFinancialsMeta = { unavailable: true };
    corporateFinancialsByBusinessNumber = new Map();
  }
}

async function loadCorporateNumbersSnapshot() {
  if (corporateNumbersMeta) return;
  try {
    const response = await fetch(CORPORATE_NUMBERS_SNAPSHOT_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    corporateNumbersMeta = payload.meta || {};
    corporateNumbersByBusinessNumber = new Map((payload.companies || [])
      .map((company) => [String(company.businessRegistrationNumber || ""), company])
      .filter(([businessNumber]) => /^\d{10}$/.test(businessNumber)));
  } catch (error) {
    console.error("[corporate-numbers] snapshot unavailable", error);
    corporateNumbersMeta = { unavailable: true };
    corporateNumbersByBusinessNumber = new Map();
  }
}

async function runNpsLookup() {
  if (npsBusy) return;
  const businessNumber = $("npsBusinessNumberInput").value.trim();
  if (businessNumber && businessNumber.replace(/[^0-9]/g, "").length < 6) {
    showToast("사업자등록번호는 숫자 6자리 이상 입력하세요.");
    $("npsBusinessNumberInput").focus();
    return;
  }
  npsBusy = true;
  npsDetail = { key: "", seq: "", html: "" };
  npsBusinessStatus = { key: "", state: "idle", data: null, error: "" };
  $("npsRunBtn").disabled = true;
  $("npsProgressWrap").hidden = false;
  $("npsProgressFill").style.width = "35%";
  $("npsProgressText").textContent = "국민연금·고용·산재보험 자료를 읽는 중입니다.";
  renderNpsPager();

  try {
    const [nps, employment] = await Promise.all([
      loadNpsSnapshot(),
      loadEmploymentInsuranceSnapshot(),
      loadCorporateFinancialsSnapshot(),
      loadCorporateNumbersSnapshot()
    ]);
    npsRows = nps.items;
    employmentInsuranceRows = employment.items;
    insuranceRows = combineInsuranceWorkplaces(npsRows, employmentInsuranceRows);
    npsPageNo = 1;
    npsAppliedCriteria = npsCriteria();
    npsCriteriaDirty = false;
    $("npsResultSection").hidden = false;
    renderNps();
    renderNpsCriteriaState();
    $("npsProgressFill").style.width = "100%";
    $("npsProgressText").textContent = `사업장 ${filteredNpsRows().length.toLocaleString("ko-KR")}개를 조회했습니다.`;
    showToast(`사업장 ${filteredNpsRows().length.toLocaleString("ko-KR")}개를 조회했습니다.`);
  } catch (error) {
    $("npsProgressFill").style.width = "0%";
    $("npsProgressText").textContent = error.message;
    showToast(error.message);
  } finally {
    npsBusy = false;
    $("npsRunBtn").disabled = false;
    renderNpsPager();
  }
}

function employmentInsuranceTypeBadge(row) {
  const className = row.insuranceType === "0" ? "badge-green" : row.insuranceType === "1" ? "badge-yellow" : "badge-gray";
  return `<span class="badge ${className}">${escapeHtml(row.insuranceTypeName || insuranceTypeName(row.insuranceType))}</span>`;
}

function employmentInsuranceStatusBadge(value) {
  if (!value) return '<span class="badge badge-gray">-</span>';
  const className = String(value).endsWith("계속") ? "badge-green" : "badge-gray";
  return `<span class="badge ${className}">${escapeHtml(value)}</span>`;
}

function employmentInsuranceCountLabel(value) {
  return typeof value === "number" ? `${value.toLocaleString("ko-KR")}명` : "-";
}

function corporateRegistrationNumberHtml(businessNumber) {
  const digits = String(businessNumber || "").replace(/[^0-9]/g, "");
  const company = /^\d{10}$/.test(digits) ? corporateNumbersByBusinessNumber.get(digits) : null;
  const corporateNumber = String(company?.corporateRegistrationNumber || "");
  const formattedCorporateNumber = /^\d{13}$/.test(corporateNumber)
    ? `${corporateNumber.slice(0, 6)}-${corporateNumber.slice(6)}`
    : corporateNumber;
  return formattedCorporateNumber ? escapeHtml(formattedCorporateNumber) : "-";
}

function employmentInsuranceDetailHtml(row, { sharedWithNps = false } = {}) {
  if (!row) return "";
  const detailRow = (label, value) => (value == null || value === "" ? "" : `<div><dt>${label}</dt><dd>${value}</dd></div>`);
  const sourceRows = insuranceSourceRows(row);
  const managementGroups = new Map();
  for (const sourceRow of sourceRows) {
    const management = String(sourceRow.workplaceManagementNumber ?? "").trim();
    const key = management || `source:${sourceRow.id}`;
    const group = managementGroups.get(key) || [];
    group.push(sourceRow);
    managementGroups.set(key, group);
  }
  const managementSections = [...managementGroups.entries()].map(([management, rows]) => {
    const groupedRow = { sourceRows: rows };
    const details = [];
    const addresses = [...new Set(rows.map((sourceRow) => sourceRow.address).filter(Boolean))];
    const typeNames = [...new Set(rows.map((sourceRow) => sourceRow.insuranceTypeName || insuranceTypeName(sourceRow.insuranceType)).filter(Boolean))];
    if (!sharedWithNps) addresses.forEach((address) => details.push(detailRow("사업장 주소", escapeHtml(address))));
    if (typeNames.length) details.push(detailRow("보험 구분", escapeHtml(typeNames.join(" · "))));

    for (const kind of ["employment", "industrial"]) {
      const label = kind === "employment" ? "고용보험" : "산재보험";
      const countField = kind === "employment" ? "employmentWorkerCount" : "industrialWorkerCount";
      const dateField = kind === "employment" ? "employmentEstablishedDate" : "industrialEstablishedDate";
      const statusField = kind === "employment" ? "employmentStatus" : "industrialStatus";
      for (const sourceRow of insuranceCoverageRows(groupedRow, kind)) {
        details.push(detailRow(`${label} 상시근로자`, employmentInsuranceCountLabel(sourceRow[countField])));
        details.push(detailRow(`${label} 성립일자`, sourceRow[dateField] ? escapeHtml(formatYmd(sourceRow[dateField])) : "미기재"));
        details.push(detailRow(`${label} 사업 구분`, sourceRow[statusField] ? employmentInsuranceStatusBadge(sourceRow[statusField]) : "미기재"));
        const industryCode = sourceRow.employmentIndustryCode11 || sourceRow.employmentIndustryCode;
        const industryName = sourceRow.employmentIndustryName11 || sourceRow.employmentIndustryName;
        if (industryCode || industryName) details.push(detailRow(`${label} 업종`, escapeHtml([industryCode, industryName].filter(Boolean).join(" "))));
      }
    }

    return `<section class="insurance-workplace-group">
      <h4>사업장관리번호 <span class="insurance-workplace-number mono">${escapeHtml(management || "미기재")}</span></h4>
      <dl>${details.join("")}</dl>
    </section>`;
  }).join("");

  const businessSummary = sharedWithNps ? "" : `<dl class="insurance-business-summary">
      ${detailRow("사업자등록번호", escapeHtml(row.businessRegistrationNumber || "-"))}
      ${detailRow("법인등록번호", corporateRegistrationNumberHtml(row.businessRegistrationNumber))}
    </dl>`;
  return `<section class="detail-section">
    <h3>고용·산재보험 정보 ${employmentInsuranceTypeBadge(row)}</h3>
    ${businessSummary}
    <div class="insurance-workplace-groups">${managementSections}</div>
  </section>`;
}

function businessNumberForStatus(row) {
  const candidates = [
    row.employmentInsurance?.businessRegistrationNumber,
    ...insuranceSourceRows(row.employmentInsurance).map((sourceRow) => sourceRow.businessRegistrationNumber)
  ];
  return candidates
    .map((value) => String(value ?? "").replace(/[^0-9]/g, ""))
    .find((value) => /^\d{10}$/.test(value)) || "";
}

function businessStatusHtml(row) {
  const businessNumber = businessNumberForStatus(row);
  const status = npsBusinessStatus.key === row.key ? npsBusinessStatus : { state: "idle", data: null, error: "" };
  const loading = status.state === "loading";
  const buttonLabel = loading ? "확인 중..." : status.state === "success" ? "다시 확인" : "사업자 상태 확인";
  const buttonDisabled = !businessNumber || loading ? " disabled" : "";
  const button = `<button class="button button-secondary business-status-button" type="button" data-business-status="${escapeHtml(row.key)}"${buttonDisabled}>${buttonLabel}</button>`;
  let result = "";

  if (!businessNumber) {
    result = '<p class="field-note">고용·산재 자료에 전체 사업자등록번호가 없어 국세청 실시간 조회를 할 수 없습니다.</p>';
  } else if (status.state === "error") {
    result = `<p class="summary-empty" role="alert">${escapeHtml(status.error)}</p>`;
  } else if (status.state === "success") {
    const data = status.data || {};
    const detailRow = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    result = `<div class="business-status-result" role="status" aria-live="polite"><dl>
      ${detailRow("과세 유형", badge("tax", data.tax_type, data.tax_type_cd))}
      ${detailRow("사업자 상태", badge("status", data.b_stt, data.b_stt_cd))}
      ${detailRow("폐업일", escapeHtml(data.end_dt ? formatYmd(data.end_dt) : "-"))}
    </dl></div>`;
  }

  return `<section class="detail-section business-status-section">
    <h3>사업자 상태</h3>
    <div class="business-status-actions">${button}${businessNumber ? '<span class="field-note">국세청 실시간 조회</span>' : ""}</div>
    ${result}
  </section>`;
}

function corporateFinancialHtml(row) {
  const businessNumber = businessNumberForStatus(row);
  const company = corporateFinancialsByBusinessNumber.get(businessNumber);
  if (!company) return "";

  const statementsByYear = new Map();
  for (const statement of company.statements || []) {
    const year = String(statement.businessYear || "");
    const current = statementsByYear.get(year);
    if (!current || (!String(current.statementTypeName).includes("별도") && String(statement.statementTypeName).includes("별도"))) {
      statementsByYear.set(year, statement);
    }
  }
  const statements = [...statementsByYear.values()]
    .sort((left, right) => String(right.businessYear).localeCompare(String(left.businessYear)));
  if (!statements.length) return "";

  const amountLabel = (value) => typeof value === "number"
    ? `${Math.round(value / 100000000).toLocaleString("ko-KR")}억원`
    : "-";
  const ratioLabel = (value) => typeof value === "number"
    ? `${value.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`
    : "-";
  const corporateNumber = String(company.corporateRegistrationNumber || "");
  const formattedCorporateNumber = /^\d{13}$/.test(corporateNumber)
    ? `${corporateNumber.slice(0, 6)}-${corporateNumber.slice(6)}`
    : corporateNumber;
  const cards = statements.map((statement) => `<article class="financial-year-card">
    <h4>${escapeHtml(statement.businessYear)}년 <span>${escapeHtml(statement.statementTypeName || "요약재무제표")}</span></h4>
    <dl>
      <div><dt>매출액</dt><dd>${amountLabel(statement.sales)}</dd></div>
      <div><dt>영업이익</dt><dd>${amountLabel(statement.operatingProfit)}</dd></div>
      <div><dt>당기순이익</dt><dd>${amountLabel(statement.netIncome)}</dd></div>
      <div><dt>총자산</dt><dd>${amountLabel(statement.totalAssets)}</dd></div>
      <div><dt>총부채</dt><dd>${amountLabel(statement.totalDebt)}</dd></div>
      <div><dt>부채비율</dt><dd>${ratioLabel(statement.debtRatio)}</dd></div>
    </dl>
  </article>`).join("");

  return `<section class="detail-section corporate-financial-section">
    <h3>기업 재무정보 <span class="chart-note">법인 전체 기준</span></h3>
    <p class="selection-name">${escapeHtml(company.name)}</p>
    <p class="financial-corporate-number">법인등록번호 <span class="mono">${escapeHtml(formattedCorporateNumber)}</span></p>
    <div class="financial-year-grid">${cards}</div>
    <p class="field-note">동구 사업장 단독 실적이 아닌 법인 전체 재무제표입니다. 별도재무제표를 우선 표시하고, 없으면 연결재무제표를 표시합니다.</p>
  </section>`;
}

async function verifyBusinessStatus(rowKey) {
  const row = insuranceRows.find((item) => item.key === rowKey);
  const businessNumber = row && businessNumberForStatus(row);
  if (!row || !businessNumber) return;

  npsBusinessStatus = { key: rowKey, state: "loading", data: null, error: "" };
  renderNpsTable();
  try {
    const [data] = await callBusinessProxy([businessNumber]);
    if (!data) throw new Error("국세청에서 사업자 상태 정보를 찾을 수 없습니다.");
    if (npsDetail.key !== rowKey) return;
    npsBusinessStatus = { key: rowKey, state: "success", data, error: "" };
  } catch (error) {
    if (npsDetail.key !== rowKey) return;
    npsBusinessStatus = { key: rowKey, state: "error", data: null, error: error.message };
  }
  renderNpsTable();
}

/**
 * 상세 카드. 누른 행 바로 아래 한 줄을 끼워 펼치고, 같은 행을 다시 누르면 접는다.
 * 표는 상세를 채우는 동안에도 다시 그려지므로 카드 내용은 상태로 들고 있는다.
 */
async function showNpsDetail(rowKey) {
  if (npsDetail.key === rowKey) {
    npsDetail = { key: "", seq: "", html: "" };
    npsBusinessStatus = { key: "", state: "idle", data: null, error: "" };
    renderNpsTable();
    return;
  }
  const listRow = insuranceRows.find((row) => row.key === rowKey);
  if (!listRow) return;
  const nps = listRow.nps;
  const employment = listRow.employmentInsurance;
  const seq = nps?.seq || "";
  npsBusinessStatus = { key: rowKey, state: "idle", data: null, error: "" };
  if (!nps) {
    npsDetail = { key: rowKey, seq: "", html: employmentInsuranceDetailHtml(employment) };
    renderNpsTable();
    document.querySelector("#npsResultBody .detail-row")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  const npsLoading = `<section class="detail-section">
    <h3>국민연금 상세 정보</h3>
    <p>국민연금 사업장 상세 정보를 불러오는 중입니다.</p>
  </section>`;
  npsDetail = { key: rowKey, seq, html: `${npsLoading}${employmentInsuranceDetailHtml(employment, { sharedWithNps: true })}` };
  renderNpsTable();

  let base;
  try {
    const payload = await fetchNps({ action: "detail", seq });
    const detail = payload.items?.[0];
    if (!detail) throw new Error("사업장 상세 정보를 찾을 수 없습니다.");
    const row = (label, value) => (value == null ? "" : `<div><dt>${label}</dt><dd>${value}</dd></div>`);
    const people = (value) => (value == null ? null : `${value.toLocaleString("ko-KR")}명`);
    const enrichedAddresses = insuranceAddressValues(employment);
    const enrichedPostalCodes = insurancePostalCodeValues(employment);
    const businessNumber = employment?.businessRegistrationNumber
      || (detail.bizNoPrefix ? `${detail.bizNoPrefix}-****` : "-");
    const address = enrichedAddresses.join(" / ") || displayAddress(detail.address) || "-";
    base = `<section class="detail-section">
      <h3>국민연금 상세 정보</h3>
      <p class="selection-name">${escapeHtml(detail.name)}</p>
      <dl>
        ${row("사업자등록번호", escapeHtml(businessNumber))}
        ${row("법인등록번호", corporateRegistrationNumberHtml(businessNumber))}
        ${row("소재지", escapeHtml(address))}
        ${enrichedPostalCodes.length ? row("우편번호", escapeHtml(enrichedPostalCodes.join(" / "))) : ""}
        ${row("업종 대분류", escapeHtml(detail.sectionName))}
        ${row("사업장 형태", escapeHtml(detail.styleName))}
        ${row("가입 상태", escapeHtml(detail.statusName))}
        ${row("사업장 등록일", escapeHtml(formatYmd(detail.registeredDate)))}
        ${row("사업장 탈퇴일", detail.withdrawnDate ? escapeHtml(formatYmd(detail.withdrawnDate)) : null)}
        ${row("가입자 수", people(detail.subscriberCount))}
        ${row("월별 신규 취득자", people(detail.newSubscriberCount))}
        ${row("월별 상실 가입자", people(detail.lostSubscriberCount))}
        ${row("당월 고지금액", detail.monthlyNoticeAmount == null ? "-" : `${detail.monthlyNoticeAmount.toLocaleString("ko-KR")}원`)}
      </dl>
    </section>`;
  } catch (error) {
    if (npsDetail.key !== rowKey) return;
    const npsError = `<section class="detail-section">
      <h3>국민연금 상세 정보</h3>
      <p class="summary-empty">국민연금 상세 정보를 불러오지 못했습니다. ${escapeHtml(error.message)}</p>
    </section>`;
    npsDetail = { key: rowKey, seq, html: `${npsError}${employmentInsuranceDetailHtml(employment, { sharedWithNps: true })}` };
    renderNpsTable();
    return;
  }
  if (npsDetail.key !== rowKey) return;

  const historyRows = (nps.historyRows ?? []).filter((row) => row.seq && row.month);
  const pending = historyRows.length >= 2 ? `<section class="detail-section nps-history-section">
    <h3 class="chart-heading">국민연금 월별 추이</h3>
    <p class="summary-empty">국민연금 월별 추이를 불러오는 중입니다.</p>
  </section>` : "";
  const employmentHtml = employmentInsuranceDetailHtml(employment, { sharedWithNps: true });
  npsDetail = { key: rowKey, seq, html: base + pending + employmentHtml };
  renderNpsTable();
  document.querySelector("#npsResultBody .detail-row")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (!pending) return;

  const charts = await npsHistoryHtml(historyRows);
  if (npsDetail.key !== rowKey) return;
  npsDetail = { key: rowKey, seq, html: base + charts + employmentHtml };
  renderNpsTable();
}

/** 접어 둔 월별 이력을 불러 상세 카드 아래에 붙일 추이 그래프 마크업을 만든다. */
async function npsHistoryHtml(historyRows) {
  try {
    const seqs = historyRows.slice(0, NPS_HISTORY_MAX_POINTS).map((row) => `${row.seq}:${row.month}`).join(",");
    const { series } = await fetchNps({ action: "history", seqs });
    const points = (series || []).filter((point) => point.month).sort((a, b) => a.month.localeCompare(b.month));
    if (points.length < 2) return "";
    return `<section class="detail-section nps-history-section">
      <h3 class="chart-heading">국민연금 월별 추이 <span class="chart-note">${points.length}개월</span></h3>
      <div class="chart-grid">
        ${trendChart("가입자 수", points, [{ key: "subscriberCount", label: "가입자 수", color: "#3987e5" }], "line", (value) => `${value.toLocaleString("ko-KR")}명`)}
        ${trendChart("당월 고지금액", points, [{ key: "monthlyNoticeAmount", label: "당월 고지금액", color: "#3987e5" }], "line", (value) => `${Math.round(value / 10000).toLocaleString("ko-KR")}만원`)}
        ${trendChart("월별 취득·상실 가입자", points, [
          { key: "newSubscriberCount", label: "신규 취득", color: "#199e70" },
          { key: "lostSubscriberCount", label: "상실", color: "#d95926" }
        ], "bar", (value) => `${value.toLocaleString("ko-KR")}명`)}
      </div>
    </section>`;
  } catch (error) {
    return `<section class="detail-section nps-history-section">
      <h3 class="chart-heading">국민연금 월별 추이</h3>
      <p class="summary-empty">국민연금 월별 추이를 불러오지 못했습니다. ${escapeHtml(error.message)}</p>
    </section>`;
  }
}

/** yyyymm을 안내창에 쓸 "yyyy년 m월"로 편다. */
function monthLabel(month) {
  const digits = String(month ?? "").replace(/[^0-9]/g, "");
  if (digits.length !== 6) return shortMonth(month);
  return `${digits.slice(0, 4)}년 ${Number(digits.slice(4))}월`;
}

/** yyyymm을 그래프 축에 쓸 yy.mm으로 줄인다. */
function shortMonth(month) {
  return String(month ?? "").replace(/^\d{2}(\d{2})(\d{2})$/, "$1.$2");
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 136;
const CHART_PAD_X = 30;
const CHART_PAD_TOP = 22;
const CHART_BASELINE = CHART_HEIGHT - 26;

/**
 * 월별 추이 그래프. 지표마다 단위가 달라 축을 겹치지 않고 그래프를 따로 그린다.
 * 값과 월 라벨은 서로 겹치지 않을 만큼만 남기고, 마지막 달은 항상 남긴다.
 */
function trendChart(title, points, series, shape, format) {
  const active = series.filter(({ key }) => points.some((point) => typeof point[key] === "number"));
  if (!active.length) {
    return `<figure class="chart"><figcaption><span>${escapeHtml(title)}</span></figcaption>
      <p class="summary-empty">제공되지 않는 항목입니다.</p></figure>`;
  }

  const values = active.flatMap(({ key }) => points.map((point) => point[key]).filter((value) => typeof value === "number"));
  const max = Math.max(...values);
  // 막대는 0에서 시작해야 길이가 값이 된다. 선그래프는 변화를 보려는 것이라 실제 범위에 맞춘다.
  const low = shape === "bar" ? 0 : Math.min(...values);
  const high = max > low ? max : low + 1;
  const step = points.length > 1 ? (CHART_WIDTH - CHART_PAD_X * 2) / (points.length - 1) : 0;
  const x = (index) => CHART_PAD_X + index * step;
  const y = (value) => CHART_BASELINE - ((value - low) / (high - low)) * (CHART_BASELINE - CHART_PAD_TOP);

  const labelStep = Math.max(1, Math.ceil(30 * active.length / Math.max(step, 1)));
  const tickStep = Math.max(1, Math.ceil(30 / Math.max(step, 1)));
  const keepFromEnd = (index, every) => (points.length - 1 - index) % every === 0;

  let marks = "";
  if (shape === "line") {
    marks = active.map(({ key, color }) => {
      const drawn = points.map((point, index) => ({ value: point[key], index })).filter((point) => typeof point.value === "number");
      const path = drawn.map((point, order) => `${order ? "L" : "M"}${x(point.index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
      const dots = drawn.map((point) => `<circle cx="${x(point.index).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="3.5" fill="${color}" stroke="var(--surface)" stroke-width="2"></circle>`).join("");
      const labels = drawn.filter((point) => keepFromEnd(point.index, labelStep))
        .map((point) => `<text x="${x(point.index).toFixed(1)}" y="${(y(point.value) - 8).toFixed(1)}" text-anchor="middle" class="chart-value">${escapeHtml(format(point.value))}</text>`).join("");
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>${dots}${labels}`;
    }).join("");
  } else {
    const slot = Math.max(4, Math.min(12, (step || CHART_WIDTH / 3) / active.length - 2));
    marks = points.map((point, index) => active.map(({ key, color }, order) => {
      const value = point[key];
      if (typeof value !== "number") return "";
      // 같은 달의 막대는 계열 수만큼 나란히 놓고 사이에 틈을 둔다.
      const left = x(index) - (slot * active.length + 2 * (active.length - 1)) / 2 + order * (slot + 2);
      const top = y(value);
      // 두 계열의 막대가 붙어 있어 값 라벨은 막대 색을 그대로 입혀 어느 쪽 값인지 알 수 있게 한다.
      const label = keepFromEnd(index, labelStep)
        ? `<text x="${(left + slot / 2).toFixed(1)}" y="${(top - 5).toFixed(1)}" text-anchor="middle" class="chart-value" style="fill:${color}">${escapeHtml(format(value))}</text>`
        : "";
      return `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${slot.toFixed(1)}" height="${Math.max(1, CHART_BASELINE - top).toFixed(1)}" rx="2" fill="${color}"></rect>${label}`;
    }).join("")).join("");
  }

  // 막대·꼭짓점 위에 뜨는 안내창의 내용. 막대는 좁아서 열 전체를 덮는 투명한 판으로 받는다.
  const hits = points.map((point, index) => {
    const tip = {
      month: monthLabel(point.month),
      rows: active.map(({ key, label, color }) => ({
        label,
        color,
        value: typeof point[key] === "number" ? format(point[key]) : "자료 없음"
      }))
    };
    return `<rect x="${(x(index) - Math.max(step, 8) / 2).toFixed(1)}" y="0" width="${Math.max(step, 8).toFixed(1)}" height="${CHART_BASELINE}" fill="transparent" class="chart-hit" data-tip="${escapeHtml(JSON.stringify(tip))}"></rect>`;
  }).join("");

  const ticks = points.map((point, index) => (keepFromEnd(index, tickStep)
    ? `<text x="${x(index).toFixed(1)}" y="${CHART_HEIGHT - 8}" text-anchor="middle" class="chart-axis">${escapeHtml(shortMonth(point.month))}</text>`
    : "")).join("");

  const legend = active.length > 1
    ? `<span class="chart-legend">${active.map(({ label, color }) => `<span><i style="background:${color}"></i>${escapeHtml(label)}</span>`).join("")}</span>`
    : "";

  return `<figure class="chart">
    <figcaption><span>${escapeHtml(title)}</span>${legend}</figcaption>
    <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(title)} 월별 추이">
      <line x1="${CHART_PAD_X - 6}" y1="${CHART_BASELINE}" x2="${CHART_WIDTH - CHART_PAD_X + 6}" y2="${CHART_BASELINE}" stroke="var(--line)" stroke-width="1"></line>
      ${marks}
      ${hits}
      ${ticks}
    </svg>
  </figure>`;
}

/**
 * 그래프 위에 뜨는 미니 안내창. 상세 카드가 다시 그려져도 살아 있도록 문서에 한 번만 걸고,
 * 커서를 따라다니되 화면 밖으로 밀려나지 않게 가장자리에서 붙잡는다.
 */
let chartTipEl = null;
function chartTipNode() {
  if (!chartTipEl) {
    chartTipEl = document.createElement("div");
    chartTipEl.className = "chart-tip";
    chartTipEl.hidden = true;
    document.body.appendChild(chartTipEl);
  }
  return chartTipEl;
}

function hideChartTip() {
  if (chartTipEl) chartTipEl.hidden = true;
}

function showChartTip(hit, clientX, clientY) {
  let tip;
  try {
    tip = JSON.parse(hit.dataset.tip);
  } catch {
    return;
  }
  const node = chartTipNode();
  node.innerHTML = `<strong>${escapeHtml(tip.month)}</strong>${tip.rows.map(({ label, color, value }) =>
    `<span><i style="background:${escapeHtml(color)}"></i>${escapeHtml(label)}<b>${escapeHtml(value)}</b></span>`).join("")}`;
  node.hidden = false;
  const box = node.getBoundingClientRect();
  const left = Math.min(Math.max(8, clientX - box.width / 2), window.innerWidth - box.width - 8);
  const top = clientY - box.height - 12;
  node.style.left = `${left}px`;
  node.style.top = `${(top < 8 ? clientY + 16 : top)}px`;
}

document.addEventListener("mousemove", (event) => {
  const hit = event.target.closest?.(".chart-hit");
  if (hit) showChartTip(hit, event.clientX, event.clientY);
  else hideChartTip();
});
document.addEventListener("scroll", hideChartTip, true);

/** yyyymmdd 또는 yyyy-mm-dd 문자열을 yyyy.mm.dd로 보여준다. 값이 없으면 하이픈. */
function formatYmd(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (digits.length !== 8) return value || "-";
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;
}

function downloadXlsx(headers, rows, fileName, sheetName = "사업장") {
  const xlsx = window.XLSX;
  if (!xlsx) {
    showToast("XLSX 다운로드 기능을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
    return;
  }
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  xlsx.writeFile(workbook, fileName);
  showToast("XLSX 파일을 내려받았습니다.");
}

$("npsRunBtn").addEventListener("click", () => runNpsLookup());
$("npsClearBtn").addEventListener("click", () => {
  $("npsNameInput").value = "";
  $("npsBusinessNumberInput").value = "";
  $("npsAdminDongSelect").value = "";
  $("npsSectionSelect").value = "";
  $("npsIncludeWithdrawn").checked = false;
  npsPageNo = 1;
  npsDetail = { key: "", seq: "", html: "" };
  npsBusinessStatus = { key: "", state: "idle", data: null, error: "" };
  if (npsAppliedCriteria) markNpsCriteriaDirty();
});
$("npsPrevBtn").addEventListener("click", () => showNpsPage(npsPageNo - 1));
$("npsNextBtn").addEventListener("click", () => showNpsPage(npsPageNo + 1));
$("npsNameInput").addEventListener("input", markNpsCriteriaDirty);
$("npsNameInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runNpsLookup(); });
$("npsBusinessNumberInput").addEventListener("input", markNpsCriteriaDirty);
$("npsBusinessNumberInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runNpsLookup(); });
$("npsAdminDongSelect").addEventListener("change", markNpsCriteriaDirty);
$("npsSectionSelect").addEventListener("change", markNpsCriteriaDirty);
$("npsIncludeWithdrawn").addEventListener("change", markNpsCriteriaDirty);

$("npsSortSelect").addEventListener("change", (event) => {
  npsSort = event.target.value;
  npsPageNo = 1;
  npsDetail = { key: "", seq: "", html: "" };
  npsBusinessStatus = { key: "", state: "idle", data: null, error: "" };
  if (npsRows.length) renderNps();
});

$("npsResultBody").addEventListener("click", (event) => {
  const statusButton = event.target.closest("[data-business-status]");
  if (statusButton) {
    verifyBusinessStatus(statusButton.dataset.businessStatus);
    return;
  }
  const button = event.target.closest(".detail-btn");
  if (button) showNpsDetail(button.dataset.rowKey);
});
$("npsDownloadBtn").addEventListener("click", () => {
  const rows = sortedNpsRows();
  if (!rows.length) return;
  downloadXlsx(
    [
      "순번", "자료", "사업장명", "사업자등록번호", "우편번호", "소재지", "행정동",
      "국민연금 업종대분류", "고용·산재 업종코드", "고용·산재 업종명", "국민연금 사업장형태",
      "국민연금 등록일", "국민연금 가입자수", "국민연금 가입상태", "보험구분",
      "고용 성립일자", "산재 성립일자", "고용 상시근로자수", "산재 상시근로자수",
      "고용 사업구분", "산재 사업구분", "고용보험 사업장관리번호", "산재보험 사업장관리번호", "국민연금 기준월", "이력개월수"
    ],
    rows.map((row, index) => {
      const nps = row.nps;
      const employment = row.employmentInsurance;
      return [
        index + 1,
        row.source === "combined" ? "국민연금 + 고용·산재" : row.source === "nps" ? "국민연금" : "고용·산재",
        nps?.name || employment?.name || "",
        employment?.businessRegistrationNumber || (nps?.bizNoPrefix ? `${nps.bizNoPrefix}-****` : ""),
        employment?.postalCode || "",
        displayAddress(employment?.address || nps?.address),
        insuranceAdminDongLabel(row),
        nps && hasIndustryDetail(nps) ? nps.sectionName : "",
        employment?.employmentIndustryCode11 || employment?.employmentIndustryCode || "",
        employment?.employmentIndustryName11 || employment?.employmentIndustryName || "",
        nps?.styleName || "",
        nps?.registeredDate ? formatYmd(nps.registeredDate) : "",
        typeof nps?.subscriberCount === "number" ? nps.subscriberCount : "",
        nps?.statusName || "",
        employment?.insuranceTypeName || (employment ? insuranceTypeName(employment.insuranceType) : ""),
        employment?.employmentEstablishedDate ? formatYmd(employment.employmentEstablishedDate) : "",
        employment?.industrialEstablishedDate ? formatYmd(employment.industrialEstablishedDate) : "",
        insuranceWorkerCountValues(employment, "employment").join(" / "),
        insuranceWorkerCountValues(employment, "industrial").join(" / "),
        employment?.employmentStatus || "",
        employment?.industrialStatus || "",
        insuranceManagementNumbers(employment, "employment").join(" / "),
        insuranceManagementNumbers(employment, "industrial").join(" / "),
        nps?.dataCreatedMonth || "",
        nps?.historyCount || ""
      ];
    }),
    `4대보험사업장_${new Date().toISOString().slice(0, 10)}.xlsx`
  );
});

fillNpsSectionOptions();
fillNpsAdminDongOptions();

updateInputCount();
