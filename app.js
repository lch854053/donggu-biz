import {
  countBy,
  filterStores,
  storesInRadius,
  summarizeStores
} from "./lib/market.js";

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
  if (panelName === "market") initializeMarket();
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

// Commercial district analysis
const DONGGU_CENTER = [35.1467, 126.9231];
let marketInitialized = false;
let allStores = [];
let visibleStores = [];
let marketMeta = null;
let marketMap;
let markerCluster;
let storeMarkers = [];
let radiusCenter = null;
let radiusMeters = 500;
let radiusCircle;
let queryTimer;

async function initializeMarket() {
  if (marketInitialized) {
    setTimeout(() => marketMap?.invalidateSize(), 0);
    return;
  }
  marketInitialized = true;
  try {
    const response = await fetch("data/stores_donggu.json");
    if (!response.ok) throw new Error(`상가정보 파일을 불러오지 못했습니다. HTTP ${response.status}`);
    const payload = await response.json();
    allStores = Array.isArray(payload.stores) ? payload.stores : [];
    marketMeta = payload.meta || {};
    if (!allStores.length) throw new Error("상가정보 파일에 표시할 업소가 없습니다.");
    initializeMap();
    populateMarketFilters();
    buildStoreMarkers();
    applyMarketFilters();
    renderMarketMeta();
    $("marketState").hidden = true;
    $("marketWorkspace").hidden = false;
    setTimeout(() => marketMap.invalidateSize(), 0);
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
  $("marketMeta").textContent = `${marketMeta.source || "상가정보 API"} · 기준월 ${month || "미확인"} · 갱신일 ${generated} · 사업자 상태와 별도 데이터`;
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
    showCoverageOnHover: false
  }).addTo(marketMap);
  marketMap.on("click", (event) => setRadiusCenter(event.latlng));
}

function createOption(value, label) {
  return new Option(label, value);
}

function replaceOptions(select, items, placeholder) {
  const current = select.value;
  select.replaceChildren(createOption("", placeholder), ...items.map((item) => createOption(item.value, item.label)));
  if (items.some((item) => item.value === current)) select.value = current;
}

function uniqueCategories(stores, codeKey, nameKey) {
  const map = new Map();
  stores.forEach((store) => {
    if (store[codeKey]) map.set(store[codeKey], store[nameKey]);
  });
  return [...map].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ko"));
}

function populateMarketFilters() {
  replaceOptions($("dongFilter"), [...new Set(allStores.map((store) => store.adminDong).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ko")).map((name) => ({ value: name, label: name })), "전체 행정동");
  replaceOptions($("largeFilter"), uniqueCategories(allStores, "largeCode", "largeName"), "전체 대분류");
}

function updateMiddleOptions() {
  const largeCode = $("largeFilter").value;
  const candidates = largeCode ? allStores.filter((store) => store.largeCode === largeCode) : [];
  replaceOptions($("middleFilter"), uniqueCategories(candidates, "middleCode", "middleName"), "전체 중분류");
  $("middleFilter").disabled = !largeCode;
  updateSmallOptions();
}

function updateSmallOptions() {
  const middleCode = $("middleFilter").value;
  const candidates = middleCode ? allStores.filter((store) => store.middleCode === middleCode) : [];
  replaceOptions($("smallFilter"), uniqueCategories(candidates, "smallCode", "smallName"), "전체 소분류");
  $("smallFilter").disabled = !middleCode;
}

function currentMarketFilters() {
  return {
    query: $("marketQuery").value,
    adminDong: $("dongFilter").value,
    largeCode: $("largeFilter").value,
    middleCode: $("middleFilter").value,
    smallCode: $("smallFilter").value
  };
}

function buildStoreMarkers() {
  const icon = L.divIcon({ className: "store-dot", iconSize: [12, 12] });
  storeMarkers = allStores.map((store) => {
    const marker = L.marker([store.latitude, store.longitude], { icon, title: store.name });
    marker.store = store;
    marker.bindPopup(`<div class="store-popup"><strong>${escapeHtml(store.name)}${store.branch ? ` ${escapeHtml(store.branch)}` : ""}</strong><span>${escapeHtml(store.smallName || store.largeName)}</span><span>${escapeHtml(store.address)}</span></div>`);
    marker.on("click", () => setRadiusCenter(marker.getLatLng(), store));
    return marker;
  });
}

function applyMarketFilters() {
  visibleStores = filterStores(allStores, currentMarketFilters());
  const visibleIds = new Set(visibleStores.map((store) => store.id));
  markerCluster.clearLayers();
  markerCluster.addLayers(storeMarkers.filter((marker) => visibleIds.has(marker.store.id)));
  renderMarketMetrics();
  renderCategorySummary();
  if (radiusCenter) renderRadiusAnalysis();
}

function renderMarketMetrics() {
  const totalSummary = summarizeStores(allStores);
  const visibleSummary = summarizeStores(visibleStores);
  $("metricTotal").textContent = totalSummary.total.toLocaleString("ko-KR");
  $("metricFiltered").textContent = visibleSummary.total.toLocaleString("ko-KR");
  $("metricDongs").textContent = `${visibleSummary.dongCount}개`;
  $("metricTop").textContent = visibleSummary.topLarge?.name || "-";
  $("filterCount").textContent = `${visibleSummary.total.toLocaleString("ko-KR")}건`;
}

function summaryRows(counts, total, limit = 6) {
  if (!counts.length) return '<p class="radius-empty">조건에 맞는 업소가 없습니다.</p>';
  const max = counts[0].count || 1;
  return counts.slice(0, limit).map(({ name, count }) => `<div class="summary-row">
    <div class="summary-label"><span>${escapeHtml(name)}</span><strong>${count.toLocaleString("ko-KR")}</strong></div>
    <div class="summary-track" title="전체의 ${total ? Math.round(count / total * 100) : 0}%"><span style="width:${Math.round(count / max * 100)}%"></span></div>
  </div>`).join("");
}

function renderCategorySummary() {
  $("categorySummary").innerHTML = summaryRows(countBy(visibleStores, "largeName"), visibleStores.length);
}

function setRadiusCenter(latlng, store = null) {
  radiusCenter = { latitude: latlng.lat, longitude: latlng.lng };
  if (radiusCircle) radiusCircle.remove();
  radiusCircle = L.circle(latlng, {
    radius: radiusMeters,
    color: "#75aaff",
    weight: 2,
    fillColor: "#3978cf",
    fillOpacity: .12
  }).addTo(marketMap);
  $("radiusPosition").textContent = store ? store.name : `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  $("mapInstruction").textContent = `${radiusMeters >= 1000 ? `${radiusMeters / 1000}km` : `${radiusMeters}m`} 반경 · 현재 필터 기준`;
  renderRadiusAnalysis();
}

function renderRadiusAnalysis() {
  const nearby = storesInRadius(visibleStores, radiusCenter, radiusMeters);
  $("radiusEmpty").hidden = true;
  $("radiusResult").hidden = false;
  $("radiusTotal").textContent = nearby.length.toLocaleString("ko-KR");
  $("radiusCategories").innerHTML = summaryRows(countBy(nearby.map((entry) => entry.store), "smallName"), nearby.length, 5);
  $("nearbyList").innerHTML = nearby.length
    ? nearby.slice(0, 7).map(({ store, distance }) => `<li><strong>${escapeHtml(store.name)}</strong><span>${Math.round(distance).toLocaleString("ko-KR")}m · ${escapeHtml(store.smallName || store.largeName)}</span></li>`).join("")
    : "<li><span>현재 조건과 반경에 해당하는 업소가 없습니다.</span></li>";
}

$("largeFilter").addEventListener("change", () => { updateMiddleOptions(); applyMarketFilters(); });
$("middleFilter").addEventListener("change", () => { updateSmallOptions(); applyMarketFilters(); });
$("smallFilter").addEventListener("change", applyMarketFilters);
$("dongFilter").addEventListener("change", applyMarketFilters);
$("marketQuery").addEventListener("input", () => {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(applyMarketFilters, 180);
});
$("radiusOptions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-radius]");
  if (!button) return;
  radiusMeters = Number(button.dataset.radius);
  document.querySelectorAll("#radiusOptions button").forEach((item) => {
    const active = item === button;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  if (radiusCenter) setRadiusCenter({ lat: radiusCenter.latitude, lng: radiusCenter.longitude });
});
$("useMapCenterBtn").addEventListener("click", () => setRadiusCenter(marketMap.getCenter()));
$("resetMarketBtn").addEventListener("click", () => {
  $("marketQuery").value = "";
  $("dongFilter").value = "";
  $("largeFilter").value = "";
  updateMiddleOptions();
  applyMarketFilters();
  marketMap?.setView(DONGGU_CENTER, 14);
});

updateInputCount();
