import {
  buildLocationFilter,
  buildLocationSelection,
  countBy,
  filterStores,
  pointInGeometry,
  sortStores
} from "./lib/market.js";
import { filterVworldZones, mergeZoneFeatures } from "./lib/zone-update.js";
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
  filterBuildingsInZone,
  geometryBounds,
  matchBuildingIndustries
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
  if (panelName === "market") initializeMarket();
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
const MARKET_TABLE_PAGE_SIZE = 100;
let marketTableRows = [];
let marketTablePageNo = 1;
let marketTableAppliedLabel = "";

const marketViewTabs = [...document.querySelectorAll(".market-view-tab")];
function activateMarketView(viewName) {
  marketViewTabs.forEach((tab) => {
    const active = tab.dataset.marketView === viewName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    $(`market-view-${tab.dataset.marketView}`).hidden = !active;
  });
  closeClusterPanel();
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
let outlineMap;
let outlineManifest = null;
let outlineBuildingLayer;
let outlineFeatures = [];
let outlineIndustryById = new Map();
let outlineStoresById = new Map();
let outlineIndustryMode = true;
let outlineLoadId = 0;
const outlineCellCache = new Map();

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
  const supplemental = marketMeta?.supplemental;
  const sourceTotal = Number(marketMeta?.sourceTotalCount);
  const addedWithCoordinates = Number(supplemental?.addedWithCoordinatesCount);
  const addedWithoutCoordinates = Number(supplemental?.addedWithoutCoordinatesCount);
  const unavailableSources = Array.isArray(supplemental?.sources)
    ? supplemental.sources.filter((sourceInfo) => sourceInfo?.error).length
    : 0;
  const dates = [
    month ? `상가정보 기준월 ${month}` : "",
    `상가정보 갱신일 ${generated}`
  ].filter(Boolean).join(" · ");
  const count = Number.isFinite(sourceTotal) && Number.isFinite(addedWithCoordinates)
    ? `전체 ${allStores.length.toLocaleString("ko-KR")}개 (SDSC ${sourceTotal.toLocaleString("ko-KR")}개 + 인허가 좌표 보완 ${addedWithCoordinates.toLocaleString("ko-KR")}개)`
    : `전체 ${allStores.length.toLocaleString("ko-KR")}개`;
  const unresolved = Number.isFinite(addedWithoutCoordinates) && addedWithoutCoordinates > 0
    ? ` · 인허가 좌표 미확인 ${addedWithoutCoordinates.toLocaleString("ko-KR")}건(지도 제외)`
    : "";
  const unavailable = unavailableSources
    ? ` · 인허가 원천 ${unavailableSources.toLocaleString("ko-KR")}건 미수집`
    : "";
  $("marketMeta").textContent = `${source} · ${dates} · ${count}${unresolved}${unavailable}`;
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
  const panel = $("clusterPanel");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  $("clusterStoreBody").replaceChildren();
  $("clusterStats").hidden = true;
}

function clusterIndustryRows(stores) {
  const categories = countBy(stores, (store) => store.largeName || store.middleName || store.smallName || "미분류");
  const rows = categories.slice(0, 5);
  const otherCount = categories.slice(5).reduce((total, item) => total + item.count, 0);
  if (otherCount) rows.push({ name: "기타", count: otherCount });
  return { categories, rows };
}

function renderClusterIndustryChart(stores) {
  const { categories, rows } = clusterIndustryRows(stores);
  let offset = 0;
  const segments = rows.map((row, index) => {
    const start = offset;
    offset += row.count / stores.length * 100;
    return `${CLUSTER_CHART_COLORS[index]} ${start}% ${offset}%`;
  });
  const pie = $("clusterPie");
  pie.style.background = `conic-gradient(${segments.join(",")})`;
  pie.setAttribute("aria-label", `총 ${stores.length}개 업소의 업종 분포`);
  $("clusterStatsMeta").textContent = `총 ${stores.length.toLocaleString("ko-KR")}개 · ${categories.length.toLocaleString("ko-KR")}개 업종`;
  $("clusterLegend").innerHTML = rows.map((row, index) => `<div>
    <i style="background:${CLUSTER_CHART_COLORS[index]}"></i>
    <span>${escapeHtml(row.name)}</span>
    <strong>${row.count.toLocaleString("ko-KR")}개</strong>
  </div>`).join("");
  $("clusterStats").hidden = false;
}

function renderClusterPanel(stores) {
  const sortedStores = [...stores].sort((left, right) => left.name.localeCompare(right.name, "ko"));
  $("clusterPanelCount").textContent = `${sortedStores.length.toLocaleString("ko-KR")}개 업소`;
  $("clusterStoreBody").innerHTML = sortedStores.map((store, index) => `<tr>
    <td class="seq">${index + 1}</td>
    <td>${escapeHtml([store.name, store.branch].filter(Boolean).join(" "))}</td>
    <td>${escapeHtml(store.smallName || store.middleName || store.largeName || "미분류")}</td>
    <td>${escapeHtml(store.address || store.lotAddress || "-")}</td>
  </tr>`).join("");
  $("clusterStats").hidden = true;
  if (sortedStores.length >= 5) renderClusterIndustryChart(sortedStores);
  $("clusterPanel").hidden = false;
  $("clusterPanelBody").scrollTop = 0;
}

function setOutlineState(message, isError = false) {
  const state = $("outlineState");
  if (!state) return;
  state.hidden = false;
  state.classList.toggle("is-error", isError);
  state.textContent = message;
}

function clearOutlineLayers() {
  outlineBuildingLayer?.remove();
  outlineBuildingLayer = null;
  outlineFeatures = [];
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
    outlineMap.setMinZoom(0);
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

function outlineFeatureStyle(feature) {
  const industry = outlineIndustryById.get(String(feature.id));
  const color = !outlineIndustryMode
    ? OUTLINE_PLAIN_COLOR
    : industry
      ? OUTLINE_INDUSTRY_COLORS.get(industry) || OUTLINE_OTHER_COLOR
      : OUTLINE_UNMATCHED_COLOR;
  return {
    color: outlineIndustryMode && industry ? color : "#8490aa",
    weight: outlineIndustryMode && industry ? 1.15 : .7,
    opacity: .92,
    fillColor: color,
    fillOpacity: !outlineIndustryMode ? .38 : industry ? .78 : .12
  };
}

function outlineStoreName(store) {
  return [store.name, store.branch].filter(Boolean).join(" ") || "업소명 미확인";
}

function outlineStoreIndustry(store) {
  return store.smallName || store.middleName || store.largeName || "업종 미확인";
}

function outlineTooltipHtml(stores) {
  return `<div class="building-tooltip-content">
    <strong>연결 업소 ${stores.length.toLocaleString("ko-KR")}개</strong>
    ${stores.map((store) => `<div class="building-tooltip-store">
      <b>${escapeHtml(outlineStoreName(store))}</b>
      <span>업종 · ${escapeHtml(outlineStoreIndustry(store))}</span>
      <span>주소 · ${escapeHtml(store.address || store.lotAddress || "-")}</span>
    </div>`).join("")}
  </div>`;
}

function bindOutlineFeature(feature, layer) {
  const stores = outlineStoresById.get(String(feature.id)) || [];
  if (!stores.length) return;
  layer.bindTooltip(outlineTooltipHtml(stores), {
    sticky: true,
    direction: "top",
    className: "building-tooltip",
    opacity: .98
  });
  layer.on({
    mouseover() {
      layer.setStyle({
        weight: outlineIndustryMode ? 2.2 : 1.5,
        fillOpacity: outlineIndustryMode ? .92 : .5
      });
    },
    mouseout() { outlineBuildingLayer?.resetStyle(layer); }
  });
}

function renderOutlineLegend() {
  const legend = $("outlineLegend");
  legend.hidden = !outlineIndustryMode;
  if (!outlineIndustryMode) {
    legend.replaceChildren();
    return;
  }
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
      const color = industry === "점포 미연결"
        ? OUTLINE_UNMATCHED_COLOR
        : industry === "업종 미확인"
          ? OUTLINE_UNKNOWN_COLOR
          : OUTLINE_INDUSTRY_COLORS.get(industry) || OUTLINE_OTHER_COLOR;
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

async function loadBuildingOutline() {
  const zone = selectedZone();
  const requestId = ++outlineLoadId;
  clearOutlineLayers();
  if (!zone || !outlineMap) {
    if (!zone && outlineMap) setOutlineState("주요상권을 선택해 주세요.");
    return;
  }

  const zoneName = zone.properties?.name || "선택 상권";
  $("outlineZoneName").textContent = zoneName;
  $("outlineZoneMeta").textContent = "건물 윤곽을 불러오는 중입니다.";
  setOutlineState(`${zoneName}의 건물 윤곽을 불러오는 중입니다.`);
  try {
    const zoneBounds = geometryBounds(zone.geometry);
    if (!zoneBounds) throw new Error("선택 상권의 경계를 읽을 수 없습니다.");
    const manifest = await loadOutlineManifest();
    const cells = manifest.cells.filter((cell) => boundsIntersect(cell.bounds, zoneBounds));
    const cellFeatures = await Promise.all(cells.map((cell) => loadOutlineCell(cell)));
    if (requestId !== outlineLoadId) return;

    const featureById = new Map();
    cellFeatures.flat().forEach((feature) => {
      const id = String(feature?.id || feature?.properties?.id || "");
      if (id && !featureById.has(id)) featureById.set(id, feature);
    });
    outlineFeatures = filterBuildingsInZone([...featureById.values()], zone.geometry);
    const stores = filterStores(allStores, { zoneGeometry: zone.geometry });
    const industryMatches = matchBuildingIndustries(outlineFeatures, stores);
    outlineIndustryById = industryMatches.byId;
    outlineStoresById = industryMatches.storesById;

    outlineBuildingLayer = L.geoJSON({ type: "FeatureCollection", features: outlineFeatures }, {
      style: outlineFeatureStyle,
      onEachFeature: bindOutlineFeature
    }).addTo(outlineMap);

    const leafletBounds = outlineBuildingLayer.getBounds();
    if (leafletBounds.isValid()) outlineMap.fitBounds(leafletBounds, { padding: [28, 28], maxZoom: 18 });

    renderOutlineZoneMeta(zone, stores, industryMatches.matchedStoreIds);
    renderOutlineLegend();
    $("outlineWorkspace").hidden = false;
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
      preferCanvas: true
    }).setView(DONGGU_CENTER, 14);
  }
  setTimeout(() => outlineMap.invalidateSize(), 0);
  loadBuildingOutline();
}

$("outlineIndustryToggle").addEventListener("change", (event) => {
  outlineIndustryMode = event.target.checked;
  outlineBuildingLayer?.setStyle(outlineFeatureStyle);
  renderOutlineLegend();
});

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
  $("outlineZoneFilter").value = selectedZoneNo;
  $("zoneFilter").disabled = !mainBizZones.length;
  $("marketTableZoneFilter").disabled = !mainBizZones.length;
  $("outlineZoneFilter").disabled = !mainBizZones.length;
}

function marketTableCriteria() {
  const zoneNo = $("marketTableZoneFilter").value;
  const zone = mainBizZones.find((feature) => feature.properties.no === zoneNo);
  return {
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
  const values = [
    $("marketTableDongFilter").selectedOptions[0]?.textContent,
    $("marketTableIndustryFilter").selectedOptions[0]?.textContent,
    $("marketTableZoneFilter").selectedOptions[0]?.textContent,
    $("marketTableSortSelect").selectedOptions[0]?.textContent
  ].filter((value) => value && !value.startsWith("전체"));
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
  $("dongFilter").value = selection.adminDong;
  syncZoneTooltips();
  zoneLayer?.setStyle(zoneStyle);
  applyMarketFilters();
  const layer = zoneLeafletByNo.get(selectedZoneNo);
  if (fitBounds && layer && !$("market-view-map").hidden) marketMap.fitBounds(layer.getBounds(), { padding: [32, 32], maxZoom: 16 });
  if (outlineMap) loadBuildingOutline();
}

$("dongFilter").addEventListener("change", (event) => {
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
$("outlineZoneFilter").addEventListener("change", (event) => selectZone(event.target.value, Boolean(event.target.value)));
$("resetMarketBtn").addEventListener("click", () => {
  $("dongFilter").value = "";
  selectZone("", false);
  marketMap?.setView(DONGGU_CENTER, 14);
});
$("clusterPanelClose").addEventListener("click", closeClusterPanel);
$("marketTableRunBtn").addEventListener("click", runMarketTableSearch);
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
$("analysisLookupBtn").addEventListener("click", () => activateMarketView("map"));

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
