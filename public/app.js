const $ = (id) => document.getElementById(id);
let storeData = null;
let ordersData = [];
let warehouseOutboundData = [];
let shipmentStores = [];
let toastTimer;

function toast(message, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = "toast", 3400);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}

function formatQuantity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "0";
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "請求失敗，請稍後再試。");
  return data;
}

function suggestionFor(product, stock, salesTotalOverride) {
  const sales = product.recentSales || [];
  const salesTotal = salesTotalOverride == null ? sales.reduce((sum, value) => sum + Number(value), 0) : Number(salesTotalOverride);
  const average = sales.length ? salesTotal / 7 : 0;
  const reorderPoint = Math.ceil(average * product.leadTimeDays + product.safetyStock);
  const target = Math.ceil(average * (product.leadTimeDays + product.reviewDays) + product.safetyStock + product.bufferStock);
  return { average: Math.round(average * 10) / 10, reorderPoint, suggestedQty: Math.max(0, Math.ceil(target - stock)) };
}

function anomalyFor(qty, suggested, unit = "件") {
  const reviewThreshold = Math.max(suggested * 3, suggested + 50);
  if (qty > reviewThreshold) return `申請 ${qty} ${unit} 超過需確認門檻 ${reviewThreshold} ${unit}（建議量 ${suggested} ${unit}）；請確認是否有促銷、活動或特殊需求。`;
  return "";
}

function productLine(product) {
  const result = suggestionFor(product, product.currentStock, product.recentSalesTotal);
  const quantityStep = "1";
  const salesStep = product.unit === "kg" ? "0.01" : "1";
  const isChunanStore = storeData?.id === "EOS-ZN-001";
  const salesLabel = isChunanStore ? "近 7 日實際出貨" : "近 7 日銷量";
  const salesHelp = isChunanStore ? `WMS 自動彙總 ${Number(product.recentSalesOrderCount || 0)} 張完成單，可核對後調整` : `單位：${escapeHtml(product.unit)}，用於計算日均需求`;
  const stockHelp = isChunanStore ? "由 WMS 現有庫存預填，可核對後調整" : `單位：${escapeHtml(product.unit)}`;
  const salesField = `<label>${salesLabel}<input type="number" min="0" step="${salesStep}" required data-field="recentSalesTotal" value="${product.recentSalesTotal}" /><small>${salesHelp}</small></label>`;
  const warehouseFact = !storeData?.warehouseConnection?.connected
    ? "中央倉資料暫不可用"
    : product.warehouseMatched
      ? `中央倉可供 ${product.warehouseAvailableQty} ${product.warehouseUnit}（${product.warehouseBatchCount} 批）`
      : `中央倉尚未對應商品（代碼 ${product.warehouseProductCode || product.sku}）`;
  const line = document.createElement("article");
  line.className = "product-line";
  line.dataset.sku = product.sku;
  line.dataset.suggested = result.suggestedQty;
  line.innerHTML = `
    <div class="product-line-head"><div><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.sku)} · ${escapeHtml(product.category)}</span></div><span class="stock-alert ${product.needsRestock ? "" : "ok"}">${product.needsRestock ? "低於再訂購點" : "庫存正常"}</span></div>
    <div class="product-facts"><span>安全庫存 <b>${product.safetyStock} ${escapeHtml(product.unit)}</b></span><span>日均需求 <b data-role="average">${result.average} ${escapeHtml(product.unit)}</b></span><span>再訂購點 <b data-role="reorder">${result.reorderPoint} ${escapeHtml(product.unit)}</b></span><span>交期 ${product.leadTimeDays} 天 · 補貨週期 ${product.reviewDays} 天</span><span class="warehouse-stock-fact ${product.warehouseMatched ? "connected" : ""}">${escapeHtml(warehouseFact)}</span></div>
    ${!isChunanStore && product.salesDataConfigured === false ? `<div class="sales-setup-note">尚無門市銷售歷史，請先輸入近 7 日銷量；目前建議量僅供示範。</div>` : ""}
    <div class="product-inputs">${salesField}<label>門市盤點庫存<input type="number" min="0" step="${salesStep}" required data-field="countedStock" value="${product.currentStock}" /><small>${stockHelp}</small></label><div class="suggested-value">系統建議<strong data-role="suggestion">${result.suggestedQty} ${escapeHtml(product.unit)}</strong><small>目標庫存扣除目前庫存</small></div><label>本次申請補貨<input type="number" min="0" step="1" required data-field="qty" value="${result.suggestedQty}" /><small>單位：${escapeHtml(product.unit)}（整數）</small></label></div>
    <div class="line-anomaly hidden" data-role="anomaly"><strong>⚠ 數量與建議差異較大</strong><p data-role="anomalyText"></p><label>修改原因（必填）<textarea rows="2" data-field="reason" placeholder="例如：大型活動、促銷或特殊天候"></textarea></label></div>`;
  line.querySelectorAll("input[data-field]").forEach(input => input.addEventListener("input", () => updateProductLine(line, product)));
  return line;
}

function updateProductLine(line, product) {
  const stockInput = line.querySelector('[data-field="countedStock"]');
  const salesInput = line.querySelector('[data-field="recentSalesTotal"]');
  const qtyInput = line.querySelector('[data-field="qty"]');
  const oldSuggestion = Number(line.dataset.suggested);
  const stock = Math.max(0, Number(stockInput.value || 0));
  const calculated = suggestionFor(product, stock, Number(salesInput?.value || 0));
  if (qtyInput.value === "" || Number(qtyInput.value) === oldSuggestion) qtyInput.value = calculated.suggestedQty;
  line.dataset.suggested = calculated.suggestedQty;
  line.querySelector('[data-role="suggestion"]').textContent = `${calculated.suggestedQty} ${product.unit}`;
  line.querySelector('[data-role="average"]').textContent = `${calculated.average} ${product.unit}`;
  line.querySelector('[data-role="reorder"]').textContent = `${calculated.reorderPoint} ${product.unit}`;
  const stockBadge = line.querySelector(".stock-alert");
  const belowReorder = stock <= calculated.reorderPoint;
  stockBadge.textContent = belowReorder ? "低於再訂購點" : "庫存正常";
  stockBadge.classList.toggle("ok", !belowReorder);
  const anomaly = anomalyFor(Number(qtyInput.value || 0), calculated.suggestedQty, product.unit);
  const box = line.querySelector('[data-role="anomaly"]');
  box.classList.toggle("hidden", !anomaly);
  box.querySelector('[data-role="anomalyText"]').textContent = anomaly;
  line.querySelector('[data-field="reason"]').required = Boolean(anomaly);
  qtyInput.classList.toggle("input-warning", Boolean(anomaly));
  updateStoreSummary();
}

function updateStoreSummary() {
  if (!storeData) return;
  const lines = [...$("productLines").querySelectorAll(".product-line")];
  const evaluated = lines.map(line => {
    const product = storeData.products.find(entry => entry.sku === line.dataset.sku);
    return suggestionFor(product, Number(line.querySelector('[data-field="countedStock"]').value || 0), Number(line.querySelector('[data-field="recentSalesTotal"]')?.value || 0));
  });
  $("restockCount").textContent = evaluated.filter((item, index) => Number(lines[index].querySelector('[data-field="countedStock"]').value || 0) <= item.reorderPoint).length;
  $("suggestionCount").textContent = evaluated.filter(item => item.suggestedQty > 0).length;
}

function renderStore(data) {
  storeData = data;
  $("storeName").textContent = data.name;
  $("managerName").textContent = data.manager;
  $("storeContact").textContent = data.phone || data.mobile ? `公務電話 ${data.phone || "未設定"} · 緊急手機 ${data.mobile || "未設定"}` : "門市聯絡資料待設定";
  const warehouseLink = $("warehouseLinkStatus");
  const link = data.warehouseConnection;
  warehouseLink.textContent = link.connected
    ? `中央倉已連線 · 對應 ${link.mappedProducts}/${data.products.length} 項`
    : "中央倉未連線";
  warehouseLink.classList.toggle("connected", link.connected);
  warehouseLink.title = link.connected
    ? `資料來源：${link.source}`
    : `目前使用 EOS 示範資料；${link.error || "請確認倉儲系統已啟動"}`;
  $("productCount").textContent = data.products.length;
  $("restockCount").textContent = data.products.filter(product => product.needsRestock).length;
  $("suggestionCount").textContent = data.products.filter(product => product.suggestedQty > 0).length;
  $("today").textContent = new Intl.DateTimeFormat("zh-TW", { year:"numeric", month:"2-digit", day:"2-digit", weekday:"short" }).format(new Date());
  const lines = $("productLines");
  lines.replaceChildren(...data.products.map(productLine));
  updateStoreSummary();
  loadStoreOrders();
}

async function loadStoreOptions() {
  const stores = await api("/api/stores");
  const select = $("storeSelect");
  stores.forEach(store => select.add(new Option(`${store.name}（${store.manager}）`, store.id)));
  select.addEventListener("change", () => loadStore(select.value));
  await loadStore(select.value || stores[0]?.id);
}

async function loadStore(storeId) {
  try { renderStore(await api(`/api/store?storeId=${encodeURIComponent(storeId)}`)); }
  catch (error) { toast(error.message, true); }
}

function renderStoreOrders(orders) {
  const pending = orders.filter(order => order.status === "待店長確認");
  $("storeDraftCount").textContent = pending.length;
  const list = $("storeOrderList");
  const visibleOrders = orders.filter(order => ["待店長確認", "已核准送倉", "已到貨"].includes(order.status));
  if (!visibleOrders.length) {
    list.innerHTML = `<div class="empty-state compact-empty">目前沒有待確認或待收貨的訂單。</div>`;
    return;
  }
  list.innerHTML = visibleOrders.map(order => {
    if (order.status === "待店長確認") return `<article class="draft-card"><div class="draft-content"><strong>${escapeHtml(order.id)} · ${escapeHtml(order.storeName)}</strong>${order.supervisorNote ? `<div class="reason-box">總部退回原因：${escapeHtml(order.supervisorNote)}</div>` : ""}<div class="draft-lines">${order.items.map(item => `<div class="draft-line"><span><strong>${escapeHtml(item.product)}</strong><small>建議 ${item.suggestedQty} ${escapeHtml(item.unit)}</small></span><label>確認申請量<input type="number" min="0" step="${item.unit === "kg" ? "0.01" : "1"}" required data-draft-qty="${escapeHtml(item.sku)}" value="${item.qty}" /></label><label>修改原因<input type="text" data-draft-reason="${escapeHtml(item.sku)}" value="${escapeHtml(item.reason)}" placeholder="數量偏離建議時必填" /></label></div>`).join("")}</div><small>請在 ${new Date(order.expiresAt).toLocaleTimeString("zh-TW")} 前核對並確認。未確認時，手動修改數量不會送出。</small></div><button class="primary-small" data-confirm-order="${escapeHtml(order.id)}">確認此單</button></article>`;
    const records = order.outboundOrders || [];
    const allShipped = records.length > 0 && records.every(record => record.status === "COMPLETED");
    const fulfillment = records.length ? records.map(record => `${escapeHtml(record.outbound_no)} · ${escapeHtml(record.product_name || record.product || "商品")} ${record.quantity} ${escapeHtml(record.unit || "")} · ${record.status === "COMPLETED" ? "已出貨" : record.status === "WAITING_PICK" ? "待揀貨" : escapeHtml(record.status)}`).join("<br>") : "尚無倉庫出貨紀錄";
    const receiveButton = order.status === "已核准送倉" && allShipped ? `<button class="primary-small" data-receive-order="${escapeHtml(order.id)}">確認門市收貨</button>` : "";
    const status = order.status === "已到貨" ? "門市已收貨" : allShipped ? "倉庫已出貨，待門市收貨" : "倉庫處理中";
    return `<article class="draft-card"><div class="draft-content"><strong>${escapeHtml(order.id)} · ${escapeHtml(order.storeName)}　${status}</strong><div class="contact-row">${fulfillment}</div></div>${receiveButton}</article>`;
  }).join("");
}

async function loadStoreOrders() {
  if (!storeData) return;
  try {
    const orders = await api(`/api/orders/store/${encodeURIComponent(storeData.id)}`);
    renderStoreOrders(orders);
  } catch (error) { toast(error.message, true); }
}

function statusClass(order) {
  if (order.status === "已核准送倉") return "status-approved";
  if (order.status === "待主管稽核") return "status-anomaly";
  if (order.status === "待總部確認" || order.status === "待店長確認") return "status-pending";
  if (order.status === "暫緩處理") return "status-neutral";
  return "status-returned";
}

function orderCard(order) {
  const lines = order.items.map(item => `<div class="hq-line ${item.anomaly ? "hq-line-alert" : ""}"><strong>${escapeHtml(item.product)} <span>(${escapeHtml(item.sku)})</span></strong><div>盤點 ${formatQuantity(item.currentStock)} ${escapeHtml(item.unit)} · 建議 ${formatQuantity(item.suggestedQty)} · 申請 ${formatQuantity(item.qty)} ${escapeHtml(item.unit)}</div>${item.anomaly ? `<small>⚠ ${escapeHtml(item.anomaly)} 修改原因：${escapeHtml(item.reason)}</small>` : ""}${item.approvedQty != null ? `<small>核准 ${formatQuantity(item.approvedQty)} ${escapeHtml(item.unit)}</small>` : ""}</div>`).join("");
  const actions = ["待總部確認", "待主管稽核", "暫緩處理"].includes(order.status) ? `<div class="order-actions"><button class="primary-small" data-action="approve_requested" data-id="${escapeHtml(order.id)}">核准店長申請量</button><button data-action="approve_suggested" data-id="${escapeHtml(order.id)}">改採系統建議量</button><button class="warn-small" data-action="return" data-id="${escapeHtml(order.id)}">退回門市確認</button><button data-action="hold" data-id="${escapeHtml(order.id)}">暫緩處理</button><button data-action="contact" data-id="${escapeHtml(order.id)}">建立聯絡紀錄</button><button data-action="no-response" data-id="${escapeHtml(order.id)}">記錄未回應</button></div>` : "";
  const timeout = order.status === "待店長確認" ? `<div class="reason-box">等待門市確認中。逾時後，系統會以建議量送交總部，訂單仍須主管核准才可送倉。</div>` : "";
  const decision = order.supervisorDecision ? `<div class="reason-box">主管決策：${escapeHtml(order.supervisorDecision)}${order.approvedSummary == null ? "" : `；核准數量 ${escapeHtml(order.approvedSummary)}`}。${order.supervisorNote ? `<br>備註：${escapeHtml(order.supervisorNote)}` : ""}</div>` : "";
  const contact = order.contactAttempt ? `<div class="contact-row">聯絡紀錄：${escapeHtml(order.contactAttempt.status)}</div>` : "";
  const auditSummary = order.auditLog.slice(-2).map(entry => escapeHtml(entry.action)).join("；");
  return `<article class="order-card ${order.anomaly ? "is-anomaly" : ""}"><div class="order-card-head"><div><h4>${escapeHtml(order.storeName)} <span class="order-sub">· ${escapeHtml(order.id)}</span></h4><div class="order-sub">${new Date(order.createdAt).toLocaleString("zh-TW")} · ${escapeHtml(order.submissionMode)}</div></div><span class="status-badge ${statusClass(order)}">${escapeHtml(order.status)}</span></div><div class="hq-lines">${lines}</div>${timeout}<div class="contact-row">店長：${escapeHtml(order.contact.manager)} · 公務電話：${escapeHtml(order.contact.phone)} · 緊急手機：${escapeHtml(order.contact.mobile)}</div>${decision}${contact}<div class="audit-preview">最近紀錄：${auditSummary}</div>${actions}</article>`;
}

async function loadOrders() {
  try {
    ordersData = await api("/api/orders");
    $("ordersList").innerHTML = ordersData.length ? ordersData.map(orderCard).join("") : `<div class="empty-state"><span>▤</span>目前尚無補貨訂單。請先至「門市補貨」建立一筆需求。</div>`;
    $("totalOrders").textContent = ordersData.length;
    $("anomalyOrders").textContent = ordersData.filter(order => order.anomaly && !["已核准送倉", "已退回門市"].includes(order.status)).length;
    $("pendingOrders").textContent = ordersData.filter(order => ["待店長確認", "待主管稽核", "待總部確認", "暫緩處理"].includes(order.status)).length;
    $("approvedOrders").textContent = ordersData.filter(order => order.status === "已核准送倉").length;
    $("pendingBadge").textContent = ordersData.filter(order => ["待店長確認", "待主管稽核", "待總部確認", "暫緩處理"].includes(order.status)).length;
    renderAudit();
    await loadStoreOrders();
  } catch (error) { toast(error.message, true); }
}

function renderAudit() {
  const events = [];
  ordersData.forEach(order => (order.auditLog || []).forEach(log => events.push({ ...log, orderId: order.id, storeName: order.storeName })));
  events.sort((a, b) => b.time.localeCompare(a.time));
  $("auditList").innerHTML = events.length ? events.map(event => `<div class="audit-item"><strong>${escapeHtml(event.action)}</strong><p>訂單 ${escapeHtml(event.orderId)} · ${escapeHtml(event.storeName)} · 操作者：${escapeHtml(event.actor)}${event.note ? `<br>備註：${escapeHtml(event.note)}` : ""}</p><time>${new Date(event.time).toLocaleString("zh-TW")}</time></div>`).join("") : `<div class="empty-state"><span>◷</span>尚無操作紀錄。</div>`;
}

async function loadWarehouseOutboundRecords() {
  const container = $("warehouseOutboundList");
  if (!container) return;
  try {
    warehouseOutboundData = await api("/api/warehouse/outbound-orders");
    renderWarehouseOutboundRecords();
  } catch (error) {
    container.innerHTML = `<div class="empty-state">無法載入倉庫出貨紀錄：${escapeHtml(error.message)}</div>`;
  }
}

function renderWarehouseOutboundRecords() {
  const container = $("warehouseOutboundList");
  if (!container) return;
  const storeFilter = $("shipmentStoreFilter")?.value || "";
  const statusFilter = $("shipmentStatusFilter")?.value || "";
  const search = ($("shipmentSearch")?.value || "").trim().toLocaleLowerCase("zh-TW");
  const records = warehouseOutboundData.map(record => {
    const match = String(record.remark || "").match(/EOS訂單\s+(\S+)\s+·\s+(.+?)\s+·/);
    const order = match ? ordersData.find(entry => entry.id === match[1]) : null;
    const storeName = order?.storeName || match?.[2] || "直接倉庫出貨";
    const storeId = order?.storeId || shipmentStores.find(store => store.name === storeName)?.id || "__direct__";
    return { ...record, orderId: match?.[1] || "", storeName, storeId };
  }).filter(record => (!storeFilter || record.storeId === storeFilter) && (!statusFilter || record.status === statusFilter))
    .filter(record => !search || [record.outbound_no, record.orderId, record.product_name, record.batch_no, record.storeName, record.remark].some(value => String(value || "").toLocaleLowerCase("zh-TW").includes(search)));
  container.innerHTML = records.length ? records.map(record => {
    const status = record.status === "COMPLETED" ? "已完成出貨" : record.status === "WAITING_PICK" ? "待揀貨" : "已取消";
    const created = record.created_at ? new Date(String(record.created_at).replace(" ", "T")).toLocaleString("zh-TW") : "—";
    return `<article class="order-card"><div class="order-card-head"><div><h4>${escapeHtml(record.product_name || "商品")} <span class="order-sub">· ${escapeHtml(record.outbound_no || "")}</span></h4><div class="order-sub">${created} · ${escapeHtml(record.storeName)}${record.orderId ? ` · 訂單 ${escapeHtml(record.orderId)}` : ""} · 批次 ${escapeHtml(record.batch_no || "—")}</div></div><span class="status-badge ${record.status === "COMPLETED" ? "status-approved" : record.status === "WAITING_PICK" ? "status-pending" : "status-neutral"}">${status}</span></div><div class="hq-lines"><div class="hq-line"><strong>出貨數量</strong><div>${escapeHtml(record.quantity)} ${escapeHtml(record.unit || "")} · ${escapeHtml(record.pick_locations || "未配置格位")}</div>${record.remark ? `<small>來源／備註：${escapeHtml(record.remark)}</small>` : ""}</div></div></article>`;
  }).join("") : `<div class="empty-state"><span>▤</span>${warehouseOutboundData.length ? "沒有符合篩選條件的出貨單。" : "目前尚無倉庫出貨單。"}</div>`;
}

async function loadShipmentStoreFilters() {
  shipmentStores = await api("/api/stores");
  const select = $("shipmentStoreFilter");
  shipmentStores.forEach(store => select.add(new Option(store.name, store.id)));
}

document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-item").forEach(nav => nav.classList.toggle("active", nav === button));
  document.querySelectorAll(".page").forEach(page => page.classList.add("hidden"));
  $(`page-${button.dataset.page}`).classList.remove("hidden");
  if (button.dataset.page === "hq" || button.dataset.page === "audit") loadOrders();
  if (button.dataset.page === "shipments") loadWarehouseOutboundRecords();
}));

$("managerConfirmed").addEventListener("change", () => {
  $("submitOrder").innerHTML = $("managerConfirmed").checked ? "確認並送交總部審核 <span>→</span>" : "暫存並等待店長確認 <span>→</span>";
});

$("orderForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!storeData) return;
  const items = [...$("productLines").querySelectorAll(".product-line")].map(line => ({
    sku: line.dataset.sku,
    countedStock: Number(line.querySelector('[data-field="countedStock"]').value),
    recentSalesTotal: Number(line.querySelector('[data-field="recentSalesTotal"]')?.value || 0),
    qty: Number(line.querySelector('[data-field="qty"]').value),
    reason: line.querySelector('[data-field="reason"]').value.trim()
  }));
  for (const line of $("productLines").querySelectorAll(".product-line")) {
    const qty = Number(line.querySelector('[data-field="qty"]').value);
    const suggested = Number(line.dataset.suggested);
    const product = storeData.products.find(entry => entry.sku === line.dataset.sku);
    if (anomalyFor(qty, suggested, product?.unit) && !line.querySelector('[data-field="reason"]').value.trim()) {
      line.querySelector('[data-field="reason"]').focus();
      return toast("異常補貨數量需要填寫原因。", true);
    }
  }
  const button = $("submitOrder");
  button.disabled = true;
  try {
    const order = await api("/api/orders", { method:"POST", body:JSON.stringify({ storeId:storeData.id, items, managerConfirmed:$("managerConfirmed").checked }) });
    toast(order.managerConfirmed ? `訂單 ${order.id} 已送交總部審核。` : `訂單 ${order.id} 已暫存，等待店長確認。`);
    $("managerConfirmed").checked = false;
    $("managerConfirmed").dispatchEvent(new Event("change"));
    await loadStore(storeData.id);
    await loadOrders();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

$("storeOrderList").addEventListener("click", async event => {
  const receiveButton = event.target.closest("button[data-receive-order]");
  if (receiveButton) {
    receiveButton.disabled = true;
    try {
      await api(`/api/orders/${encodeURIComponent(receiveButton.dataset.receiveOrder)}/receive`, { method:"POST", body:JSON.stringify({}) });
      toast("已確認門市收貨，門市庫存已更新。");
      await loadStore(storeData.id);
      await loadOrders();
    } catch (error) { toast(error.message, true); }
    finally { receiveButton.disabled = false; }
    return;
  }
  const button = event.target.closest("button[data-confirm-order]");
  if (!button) return;
  const card = button.closest(".draft-card");
  const items = [...card.querySelectorAll("[data-draft-qty]")].map(input => ({
    sku: input.dataset.draftQty,
    qty: Number(input.value),
    reason: [...card.querySelectorAll("[data-draft-reason]")].find(reason => reason.dataset.draftReason === input.dataset.draftQty).value.trim()
  }));
  button.disabled = true;
  try {
    await api(`/api/orders/${encodeURIComponent(button.dataset.confirmOrder)}/confirm`, { method:"POST", body:JSON.stringify({ items }) });
    toast("已確認並送交總部審核。" );
    await loadOrders();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

$("refreshOrders").addEventListener("click", loadOrders);
$("refreshOutbound").addEventListener("click", loadWarehouseOutboundRecords);
$("shipmentSearch").addEventListener("input", renderWarehouseOutboundRecords);
$("shipmentStoreFilter").addEventListener("change", renderWarehouseOutboundRecords);
$("shipmentStatusFilter").addEventListener("change", renderWarehouseOutboundRecords);
$("ordersList").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === "contact" || action === "no-response") {
      await api(`/api/orders/${encodeURIComponent(id)}/${action}`, { method:"POST", body:JSON.stringify({}) });
      toast(action === "contact" ? "已建立聯絡紀錄（示範模式不會實際發送訊息）。" : "已記錄聯繫無回應。");
    } else {
      const order = ordersData.find(entry => entry.id === id);
      const supervisor = prompt("請輸入主管姓名（稽核用）", "營運主管");
      if (supervisor === null) return;
      let note = "";
      if (["return", "hold"].includes(action)) {
        note = prompt(action === "return" ? "請填寫退回門市的原因" : "請填寫暫緩處理的原因", "");
        if (note === null) return;
        if (!note.trim()) return toast("退回或暫緩處理需要填寫原因。", true);
      } else {
        const label = action === "approve_suggested" ? "採用各商品系統建議量" : "核准店長申請數量";
        note = prompt(`請輸入決策備註（可留空）。即將${label}，仍請逐項核對。`, "");
        if (note === null) return;
        if (!confirm(`確認由 ${supervisor} 決策：${label}？`)) return;
      }
      await api(`/api/orders/${encodeURIComponent(id)}/decision`, { method:"POST", body:JSON.stringify({ decision:action, supervisor, note }) });
      toast(action === "return" ? "已退回門市重新確認。" : action === "hold" ? "訂單已暫緩。" : "主管已核准送倉。");
    }
    await loadOrders();
  } catch (error) { toast(error.message, true); }
});

loadStoreOptions().catch(error => toast(error.message, true));
loadShipmentStoreFilters().catch(error => toast(error.message, true));
loadOrders();
loadWarehouseOutboundRecords();
setInterval(() => {
  if (document.visibilityState === "visible") { loadOrders(); loadWarehouseOutboundRecords(); }
}, 15000);
