const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;
const MANAGER_CONFIRMATION_MINUTES = 10;
const UNLIMITED_CENTRAL_STOCK = process.env.EOS_UNLIMITED_CENTRAL_STOCK !== "false";
const WMS_API_URL = (process.env.WMS_API_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const productMap = require("./product-map.json");
const productUnitMap = require("./product-unit-map.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 示範資料；正式環境需改用資料庫與登入權限控管。
const stores = [
  {
    id: "EOS-001", name: "中壢中原門市", manager: "李小明", phone: "03-265-9999", mobile: "0912-345-678", lineWork: "ming.manager",
    products: [
      { sku: "RAINCOAT-01", name: "輕便雨衣", category: "季節用品", unit: "件", stock: 18, safetyStock: 20, leadTimeDays: 3, reviewDays: 2, bufferStock: 5, recentSales: [5, 7, 6, 4, 8, 6, 6] },
      { sku: "WATER-600", name: "瓶裝水 600ml", category: "飲料", unit: "瓶", stock: 36, safetyStock: 24, leadTimeDays: 1, reviewDays: 1, bufferStock: 6, recentSales: [18, 20, 16, 21, 24, 19, 22] },
      { sku: "BREAD-01", name: "鮮奶吐司", category: "麵包", unit: "包", stock: 8, safetyStock: 12, leadTimeDays: 1, reviewDays: 1, bufferStock: 3, recentSales: [7, 9, 8, 6, 10, 8, 9] }
    ]
  },
  {
    id: "EOS-002", name: "台南永康門市", manager: "陳店長", phone: "06-234-5678", mobile: "0922-345-678", lineWork: "tainan.manager",
    products: [
      { sku: "RAINCOAT-01", name: "輕便雨衣", category: "季節用品", unit: "件", stock: 42, safetyStock: 18, leadTimeDays: 3, reviewDays: 2, bufferStock: 4, recentSales: [3, 4, 5, 3, 6, 4, 5] },
      { sku: "WATER-600", name: "瓶裝水 600ml", category: "飲料", unit: "瓶", stock: 20, safetyStock: 20, leadTimeDays: 1, reviewDays: 1, bufferStock: 5, recentSales: [16, 17, 18, 20, 18, 22, 19] },
      { sku: "BREAD-01", name: "鮮奶吐司", category: "麵包", unit: "包", stock: 14, safetyStock: 10, leadTimeDays: 1, reviewDays: 1, bufferStock: 2, recentSales: [6, 7, 5, 8, 6, 7, 6] }
    ]
  },
  {
    id: "EOS-003", name: "台北信義門市", manager: "王店長", phone: "02-2720-1234", mobile: "0933-456-789", lineWork: "taipei.manager",
    products: [
      { sku: "RAINCOAT-01", name: "輕便雨衣", category: "季節用品", unit: "件", stock: 9, safetyStock: 16, leadTimeDays: 2, reviewDays: 1, bufferStock: 4, recentSales: [4, 5, 3, 6, 7, 5, 6] },
      { sku: "WATER-600", name: "瓶裝水 600ml", category: "飲料", unit: "瓶", stock: 52, safetyStock: 26, leadTimeDays: 1, reviewDays: 1, bufferStock: 6, recentSales: [21, 23, 20, 22, 26, 24, 25] },
      { sku: "BREAD-01", name: "鮮奶吐司", category: "麵包", unit: "包", stock: 5, safetyStock: 11, leadTimeDays: 1, reviewDays: 1, bufferStock: 3, recentSales: [8, 7, 9, 8, 10, 7, 9] }
    ]
  }
];
const CHUNAN_STORE_ID = "EOS-ZN-001";
stores.push({ id: CHUNAN_STORE_ID, name: "統家便利商店", manager: "待設定", phone: "", mobile: "", lineWork: "", products: [] });
let orders = [];
let nextId = 1001;
let nextSimulatedShipmentId = 1;
const simulatedOutboundOrders = [];

function calculateSuggestion(product, countedStock = product.stock, salesTotalOverride) {
  const sales = product.recentSales.slice(-7);
  const salesTotal = salesTotalOverride == null
    ? (product.sales7DayTotal == null ? sales.reduce((sum, value) => sum + Number(value), 0) : Number(product.sales7DayTotal))
    : Number(salesTotalOverride);
  const avgDailyDemand = sales.length ? salesTotal / 7 : 0;
  const reorderPoint = Math.ceil(avgDailyDemand * product.leadTimeDays + product.safetyStock);
  const targetStock = Math.ceil(avgDailyDemand * (product.leadTimeDays + product.reviewDays) + product.safetyStock + product.bufferStock);
  return {
    avgDailyDemand: Math.round(avgDailyDemand * 10) / 10,
    recentSales: sales,
    recentSalesTotal: salesTotal,
    reorderPoint,
    targetStock,
    suggestedQty: Math.max(0, Math.ceil(targetStock - countedStock)),
    needsRestock: countedStock <= reorderPoint
  };
}

function findStore(storeId) { return stores.find(store => store.id === storeId); }
function findOrder(orderId) { return orders.find(order => order.id === orderId); }

function getProductUnit(source) {
  const configured = productUnitMap[String(source.product_code)]
    || Object.entries(productUnitMap).find(([name]) => String(source.name || "").includes(name))?.[1];
  const kgPerUnit = Number(configured?.kgPerUnit || 1);
  return {
    unit: configured?.unit || source.unit,
    inventoryUnit: source.unit,
    kgPerUnit: Number.isFinite(kgPerUnit) && kgPerUnit > 0 ? kgPerUnit : 1
  };
}

async function readWarehouseInventory() {
  try {
    const response = await fetch(`${WMS_API_URL}/api/inventory`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`倉儲 API 回應 ${response.status}`);
    const inventory = await response.json();
    if (!Array.isArray(inventory)) throw new Error("倉儲 API 回傳格式不正確");
    return { connected: true, inventory, source: WMS_API_URL };
  } catch (error) {
    return { connected: false, inventory: [], source: WMS_API_URL, error: error.name === "TimeoutError" ? "連線逾時" : error.message };
  }
}

async function readWarehouseProducts() {
  try {
    const response = await fetch(`${WMS_API_URL}/api/products`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`倉儲商品 API 回應 ${response.status}`);
    const products = await response.json();
    if (!Array.isArray(products)) throw new Error("倉儲商品 API 回傳格式不正確");
    return { connected: true, products, source: WMS_API_URL };
  } catch (error) {
    return { connected: false, products: [], source: WMS_API_URL, error: error.name === "TimeoutError" ? "連線逾時" : error.message };
  }
}

async function createWarehouseFulfillment(order, approvedItems) {
  if (UNLIMITED_CENTRAL_STOCK) {
    const now = new Date().toISOString();
    return approvedItems.filter(entry => Number(entry.approvedQty) > 0).map(item => {
      const id = `SIM-${Date.now()}-${nextSimulatedShipmentId++}`;
      const displayUnit = item.unit;
      const kgPerUnit = Number(item.kgPerUnit || 1);
      const inventoryUnit = item.inventoryUnit || item.unit;
      const baseQuantity = Math.round((Number(item.approvedQty) * kgPerUnit + Number.EPSILON) * 100) / 100;
      const record = {
        outboundOrderId: id,
        outbound_no: id,
        product: item.product,
        product_name: item.product,
        product_code: item.sku,
        quantity: Number(item.approvedQty),
        unit: displayUnit,
        status: "COMPLETED",
        simulated: true,
        pick_locations: "總部演示出貨（未扣 WMS 實際庫存）",
        remark: `EOS訂單 ${order.id} · ${order.storeName} · ${item.product} · 模擬 ${item.approvedQty} ${displayUnit}（約 ${baseQuantity} ${inventoryUnit}）`,
        created_at: now,
        completed_at: now
      };
      simulatedOutboundOrders.unshift(record);
      return record;
    });
  }

  const inventoryResponse = await fetch(`${WMS_API_URL}/api/inventory`, { signal: AbortSignal.timeout(5000) });
  if (!inventoryResponse.ok) throw new Error(`倉儲庫存 API 回應 ${inventoryResponse.status}`);
  const inventory = await inventoryResponse.json();
  const plan = [];
  for (const item of approvedItems.filter(entry => Number(entry.approvedQty) > 0)) {
    const kgPerUnit = Number(item.kgPerUnit || 1);
    const inventoryUnit = item.inventoryUnit || item.unit;
    const batches = inventory
      .filter(batch => batch.product_code === item.sku && batch.unit === inventoryUnit && Number(batch.qty) > 0)
      .sort((a, b) => String(a.inboundDate || a.receivedAt).localeCompare(String(b.inboundDate || b.receivedAt)) || Number(a.id) - Number(b.id));
    let remaining = Math.round((Number(item.approvedQty) * kgPerUnit + Number.EPSILON) * 100) / 100;
    const allocations = [];
    for (const batch of batches) {
      const quantity = Math.min(Number(batch.qty), remaining);
      if (quantity > 0) allocations.push({ batchId: batch.id, quantity });
      remaining = Math.round((remaining - quantity + Number.EPSILON) * 100) / 100;
      if (remaining <= 0.000001) break;
    }
    if (remaining > 0.000001) {
      const missing = Math.round((remaining / kgPerUnit + Number.EPSILON) * 100) / 100;
      throw new Error(`${item.product} 中央倉可供量不足，尚缺 ${missing} ${item.unit}（約 ${remaining} ${inventoryUnit}）；訂單未核准。`);
    }
    plan.push(...allocations.map(allocation => ({
      ...allocation,
      product: item.product,
      sku: item.sku,
      unit: inventoryUnit,
      displayUnit: item.unit,
      displayQuantity: Math.round((allocation.quantity / kgPerUnit + Number.EPSILON) * 100) / 100
    })));
  }

  const created = [];
  try {
    for (const allocation of plan) {
      const response = await fetch(`${WMS_API_URL}/api/outbound-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: allocation.batchId, quantity: allocation.quantity, remark: `EOS訂單 ${order.id} · ${order.storeName} · ${allocation.product} · ${allocation.displayQuantity} ${allocation.displayUnit}（${allocation.quantity} ${allocation.unit}）` }),
        signal: AbortSignal.timeout(5000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || `${allocation.product} 建立倉庫出貨單失敗`);
      created.push({ ...data, product: allocation.product, sku: allocation.sku, unit: allocation.unit, quantity: allocation.quantity, status: "WAITING_PICK" });
    }
    return created;
  } catch (error) {
    await Promise.allSettled(created.map(record => fetch(`${WMS_API_URL}/api/outbound-orders/${record.outboundOrderId}/cancel`, { method: "POST", signal: AbortSignal.timeout(3000) })));
    throw error;
  }
}

async function readWarehouseOutboundOrders() {
  try {
    const response = await fetch(`${WMS_API_URL}/api/outbound-orders?status=ALL`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return [...simulatedOutboundOrders];
    const records = await response.json();
    return [...simulatedOutboundOrders, ...(Array.isArray(records) ? records : [])];
  } catch {
    return [...simulatedOutboundOrders];
  }
}

function withOutboundRecords(order, outboundOrders) {
  return {
    ...order,
    outboundOrders: outboundOrders.filter(record => String(record.remark || "").includes(`EOS訂單 ${order.id} ·`))
  };
}

function mapWarehouseStock(product, inventory, catalogCodes = null) {
  const mappedCode = String(productMap[product.sku] || product.sku);
  const batches = inventory.filter(item => String(item.product_code) === mappedCode);
  if (!batches.length) {
    const existsInCatalog = catalogCodes?.has(mappedCode) || false;
    return { warehouseProductCode: mappedCode, warehouseMatched: existsInCatalog, warehouseAvailableQty: existsInCatalog ? 0 : null, warehouseUnit: existsInCatalog ? product.unit : null, warehouseBatchCount: 0 };
  }
  const inventoryUnit = product.inventoryUnit || product.unit;
  if (batches.some(batch => batch.unit !== inventoryUnit)) return { warehouseProductCode: mappedCode, warehouseMatched: false, warehouseAvailableQty: null, warehouseUnit: null, warehouseBatchCount: batches.length, warehouseMappingError: "倉儲商品單位不一致" };
  const kgPerUnit = Number(product.kgPerUnit || 1);
  return {
    warehouseProductCode: mappedCode,
    warehouseMatched: true,
    warehouseAvailableQty: Math.round((batches.reduce((sum, batch) => sum + Number(batch.qty || 0), 0) / kgPerUnit + Number.EPSILON) * 100) / 100,
    warehouseUnit: product.unit,
    warehouseBatchCount: batches.length
  };
}
function detectAnomaly(qty, suggestedQty, unit = "件") {
  if (!Number.isInteger(qty) || qty < 0) return "補貨申請量必須是大於或等於 0 的整數。";
  const reviewThreshold = Math.max(suggestedQty * 3, suggestedQty + 50);
  if (qty > reviewThreshold) return `申請量 ${qty} ${unit} 超過需確認門檻 ${reviewThreshold} ${unit}（建議量 ${suggestedQty} ${unit}）；請確認是否有促銷、活動或特殊需求。`;
  return null;
}

function getOrderStatus(items) {
  return items.some(item => item.anomaly) ? "待主管稽核" : "待總部確認";
}

function summarizeByUnit(items, field) {
  const totals = new Map();
  items.forEach(item => totals.set(item.unit, (totals.get(item.unit) || 0) + Number(item[field] || 0)));
  return [...totals].map(([unit, quantity]) => `${quantity} ${unit}`).join("、");
}

function processTimedOutOrders() {
  const now = Date.now();
  orders.forEach(order => {
    if (order.status !== "待店長確認" || !order.expiresAt || Date.parse(order.expiresAt) > now) return;
    order.items.forEach(item => {
      item.qty = item.suggestedQty;
      item.reason = "逾時未確認，改採系統建議量";
      item.anomaly = null;
    });
    order.anomaly = false;
    order.requestedSummary = summarizeByUnit(order.items, "qty");
    order.status = "待總部確認";
    order.submissionMode = "逾時採用系統建議量";
    order.managerConfirmed = false;
    order.expiresAt = null;
    order.auditLog.push({
      time: new Date(now).toISOString(),
      actor: "EOS 系統",
      action: "店長確認逾時；未採用手動修改量，改以系統建議量送總部審核"
    });
  });
}
setInterval(processTimedOutOrders, 2000).unref();

app.get("/api/stores", (_req, res) => {
  res.json(stores.map(({ id, name, manager }) => ({ id, name, manager })));
});

app.get("/api/store", async (req, res) => {
  const store = findStore(String(req.query.storeId || stores[0].id));
  if (!store) return res.status(404).json({ error: "找不到此門市。" });
  const [warehouse, catalog] = await Promise.all([readWarehouseInventory(), store.id === CHUNAN_STORE_ID ? readWarehouseProducts() : Promise.resolve(null)]);
  if (catalog?.connected) {
    store.products = catalog.products.map(source => {
      const existing = store.products.find(product => product.sku === source.product_code);
      const unitSettings = getProductUnit(source);
      const toDisplayUnit = value => Math.round((Number(value || 0) / unitSettings.kgPerUnit + Number.EPSILON) * 100) / 100;
      return {
        ...(existing || { stock: 0, leadTimeDays: 1, reviewDays: 1, bufferStock: 0, recentSales: Array(7).fill(0) }),
        sku: source.product_code, name: source.name, category: source.category || "未分類",
        ...unitSettings,
        sales7DayTotal: toDisplayUnit(source.recent_sales_7d),
        recentSalesOrderCount: Number(source.recent_sales_order_count || 0),
        recentSales: Array(7).fill(toDisplayUnit(source.recent_sales_7d) / 7),
        safetyStock: toDisplayUnit(source.min_stock), sourceMinStock: Number(source.min_stock || 0)
      };
    });
  }
  const warehouseConnected = catalog ? warehouse.connected && catalog.connected : warehouse.connected;
  const catalogCodes = catalog?.connected ? new Set(catalog.products.map(product => String(product.product_code))) : null;
  const products = store.products.map(product => {
    const warehouseStock = warehouse.connected ? mapWarehouseStock(product, warehouse.inventory, catalogCodes) : { warehouseMatched: false, warehouseAvailableQty: null, warehouseUnit: null };
    const detectedStock = store.id === CHUNAN_STORE_ID && warehouseStock.warehouseAvailableQty != null
      ? Math.round((Number(warehouseStock.warehouseAvailableQty) + (UNLIMITED_CENTRAL_STOCK ? Number(product.demoReceivedQty || 0) : 0) + Number.EPSILON) * 100) / 100
      : Number(product.stock || 0);
    return {
      ...product,
      ...calculateSuggestion(product, detectedStock),
      currentStock: detectedStock,
      ...warehouseStock,
      unlimitedCentralStockDemo: UNLIMITED_CENTRAL_STOCK,
      ...(catalog ? { salesDataConfigured: product.recentSales.some(value => Number(value) > 0), forecastSetupNote: "交期預設 1 天；門市安全庫存暫參考商品最低庫存設定" } : {})
    };
  });
  res.json({ id: store.id, name: store.name, manager: store.manager, phone: store.phone, mobile: store.mobile, warehouseConnection: { connected: warehouseConnected, source: warehouse.source, error: warehouse.error || catalog?.error || null, mappedProducts: products.filter(product => product.warehouseMatched).length, unmappedProducts: products.filter(product => !product.warehouseMatched).length }, products });
});

app.get("/api/orders", async (_req, res) => {
  processTimedOutOrders();
  const outboundOrders = await readWarehouseOutboundOrders();
  res.json([...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(order => ({
    ...order,
    outboundOrders: outboundOrders.filter(record => String(record.remark || "").includes(`EOS訂單 ${order.id} ·`))
  })));
});

app.get("/api/warehouse/outbound-orders", async (_req, res) => {
  try {
    const response = await fetch(`${WMS_API_URL}/api/outbound-orders?status=ALL`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (UNLIMITED_CENTRAL_STOCK) return res.json(simulatedOutboundOrders);
      return res.status(502).json({ error: data.message || "無法取得倉庫出貨紀錄。" });
    }
    res.json([...simulatedOutboundOrders, ...(Array.isArray(data) ? data : [])]);
  } catch (error) {
    if (UNLIMITED_CENTRAL_STOCK) return res.json(simulatedOutboundOrders);
    res.status(502).json({ error: `倉庫出貨資料暫時無法連線（${WMS_API_URL}）。` });
  }
});

app.get("/api/orders/store/:storeId", async (req, res) => {
  processTimedOutOrders();
  const outboundOrders = await readWarehouseOutboundOrders();
  res.json(orders.filter(order => order.storeId === req.params.storeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(order => withOutboundRecords(order, outboundOrders)));
});

app.post("/api/orders", (req, res) => {
  const store = findStore(String(req.body.storeId || ""));
  if (!store) return res.status(400).json({ error: "請選擇有效門市。" });
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) return res.status(400).json({ error: "請至少保留一項補貨商品。" });
  const managerConfirmed = req.body.managerConfirmed === true;
  const preparedItems = [];
  const seen = new Set();
  for (const input of req.body.items) {
    const product = store.products.find(entry => entry.sku === String(input.sku));
    const countedStock = Number(input.countedStock);
    const qty = Number(input.qty);
    const recentSalesTotal = input.recentSalesTotal === undefined
      ? (store.id === CHUNAN_STORE_ID ? Number(product?.sales7DayTotal || 0) : product?.recentSales?.reduce((sum, value) => sum + Number(value), 0))
      : Number(input.recentSalesTotal);
    const reason = String(input.reason || "").trim().slice(0, 300);
    if (!product || seen.has(product.sku)) return res.status(400).json({ error: "補貨商品不存在或重複。" });
    seen.add(product.sku);
    if (!Number.isFinite(countedStock) || countedStock < 0 || Math.abs(countedStock * 100 - Math.round(countedStock * 100)) > 0.000001 || !Number.isInteger(qty) || qty < 0 || !Number.isFinite(recentSalesTotal) || recentSalesTotal < 0)
      return res.status(400).json({ error: `${product?.name || "商品"} 的盤點與近 7 日銷量需為有效數字；補貨量必須為非負整數。` });
    const suggestion = calculateSuggestion(product, countedStock, recentSalesTotal);
    const anomaly = detectAnomaly(qty, suggestion.suggestedQty, product.unit);
    if (anomaly && !reason) return res.status(400).json({ error: `${product.name}：${anomaly} 請填寫修改原因。`, anomalyRequired: true });
    preparedItems.push({
      sku: product.sku, product: product.name, category: product.category, unit: product.unit,
      inventoryUnit: product.inventoryUnit || product.unit, kgPerUnit: Number(product.kgPerUnit || 1),
      currentStock: countedStock, safetyStock: product.safetyStock,
      avgDailyDemand: suggestion.avgDailyDemand, recentSales: Array(7).fill(0), recentSalesTotal,
      leadTimeDays: product.leadTimeDays, reviewDays: product.reviewDays, bufferStock: product.bufferStock,
      suggestedQty: suggestion.suggestedQty, qty,
      reason: reason || (qty === suggestion.suggestedQty ? "依系統建議量" : "店長調整數量"),
      anomaly
    });
  }

  // 只有在所有欄位完成驗證後，才更新本次盤點數量。
  preparedItems.forEach(item => {
    const product = store.products.find(entry => entry.sku === item.sku);
    product.stock = item.currentStock;
    product.recentSales = item.recentSales;
  });
  const now = new Date();
  const order = {
    id: `EOS-${Date.now()}-${nextId++}`, storeId: store.id, storeName: store.name,
    contact: { manager: store.manager, phone: store.phone, mobile: store.mobile, lineWork: store.lineWork },
    items: preparedItems,
    requestedSummary: summarizeByUnit(preparedItems, "qty"),
    suggestedSummary: summarizeByUnit(preparedItems, "suggestedQty"),
    anomaly: preparedItems.some(item => item.anomaly),
    status: managerConfirmed ? getOrderStatus(preparedItems) : "待店長確認",
    managerConfirmed,
    submissionMode: managerConfirmed ? "店長確認後送出" : "等待店長確認",
    createdAt: now.toISOString(),
    expiresAt: managerConfirmed ? null : new Date(now.getTime() + MANAGER_CONFIRMATION_MINUTES * 60_000).toISOString(),
    auditLog: [{
      time: now.toISOString(), actor: managerConfirmed ? store.manager : "EOS 系統",
      action: managerConfirmed ? "店長核對盤點與補貨數量後送出" : `訂單暫存，等待店長確認（${MANAGER_CONFIRMATION_MINUTES} 分鐘後未確認則改採建議量）`
    }]
  };
  orders.push(order);
  res.status(201).json(order);
});

app.post("/api/orders/:id/confirm", (req, res) => {
  processTimedOutOrders();
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "找不到此訂單。" });
  if (order.status !== "待店長確認") return res.status(409).json({ error: "此訂單已送交總部或不在待確認狀態。" });
  if (req.body.items !== undefined) {
    if (!Array.isArray(req.body.items) || req.body.items.length !== order.items.length) return res.status(400).json({ error: "訂單品項資料不完整，請重新載入。" });
    const updates = new Map();
    for (const input of req.body.items) {
      const existing = order.items.find(item => item.sku === String(input.sku));
      const qty = Number(input.qty);
      const reason = String(input.reason || "").trim().slice(0, 300);
      if (!existing || updates.has(existing.sku) || !Number.isInteger(qty) || qty < 0) return res.status(400).json({ error: "請確認每項商品的補貨量皆為大於或等於 0 的整數。" });
      const anomaly = detectAnomaly(qty, existing.suggestedQty, existing.unit);
      if (anomaly && !reason) return res.status(400).json({ error: `${existing.product}：數量與建議差異較大，請填寫修改原因。` });
      updates.set(existing.sku, { qty, reason: reason || (qty === existing.suggestedQty ? "依系統建議量" : "店長調整數量"), anomaly });
    }
    order.items.forEach(item => Object.assign(item, updates.get(item.sku)));
  }
  order.managerConfirmed = true;
  order.status = getOrderStatus(order.items);
  order.anomaly = order.items.some(item => item.anomaly);
  order.requestedSummary = summarizeByUnit(order.items, "qty");
  order.submissionMode = "店長確認後送出";
  order.expiresAt = null;
  order.supervisorDecision = null;
  order.supervisorNote = null;
  order.supervisor = null;
  order.auditLog.push({ time: new Date().toISOString(), actor: order.contact.manager, action: "店長確認盤點與補貨數量，送交總部審核" });
  res.json(order);
});

app.post("/api/orders/:id/receive", async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "找不到此訂單。" });
  if (order.status !== "已核准送倉") return res.status(409).json({ error: "只有已核准的出貨訂單可以確認收貨。" });
  if (order.receivedAt) return res.status(409).json({ error: "此訂單已確認收貨。" });
  const outboundOrders = await readWarehouseOutboundOrders();
  const linked = outboundOrders.filter(record => String(record.remark || "").includes(`EOS訂單 ${order.id} ·`));
  if (!linked.length || linked.some(record => record.status !== "COMPLETED")) return res.status(409).json({ error: "倉庫尚未完成所有揀貨出貨，暫時不能確認收貨。" });
  const store = findStore(order.storeId);
  if (!store) return res.status(409).json({ error: "找不到訂單所屬門市。" });
  order.items.forEach(item => {
    const product = store.products.find(entry => entry.sku === item.sku);
    if (product) {
      product.stock = Math.round((Number(product.stock || 0) + Number(item.approvedQty || 0)) * 100) / 100;
      if (order.simulatedFulfillment) product.demoReceivedQty = Math.round((Number(product.demoReceivedQty || 0) + Number(item.approvedQty || 0)) * 100) / 100;
    }
  });
  order.receivedAt = new Date().toISOString();
  order.status = "已到貨";
  order.auditLog.push({ time: order.receivedAt, actor: store.manager, action: order.simulatedFulfillment ? "演示門市確認收貨，更新 EOS 示範庫存（WMS 實際庫存未變更）" : "門市確認收貨，更新門市庫存" });
  res.json(order);
});

app.post("/api/orders/:id/decision", async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "找不到此訂單。" });
  const { decision, supervisor, note } = req.body;
  if (!["approve_requested", "approve_suggested", "return", "hold"].includes(decision)) return res.status(400).json({ error: "無效的主管決策。" });
  if (["已核准送倉", "已到貨"].includes(order.status)) return res.status(409).json({ error: "此訂單已核准或完成收貨，不能重複處理。" });
  if (order.status === "待店長確認") return res.status(409).json({ error: "請先等待店長確認或系統逾時處理，再進行總部決策。" });
  const actor = String(supervisor || "營運主管").trim().slice(0, 50) || "營運主管";
  const supervisorNote = String(note || "").trim().slice(0, 300);
  if ((decision === "return" || decision === "hold") && !supervisorNote) return res.status(400).json({ error: "退回或暫緩處理時，請填寫原因。" });
  let warehouseFulfillment = [];
  if (decision === "approve_requested" || decision === "approve_suggested") {
    order.items.forEach(item => { item.approvedQty = decision === "approve_suggested" ? item.suggestedQty : item.qty; });
    try {
      warehouseFulfillment = await createWarehouseFulfillment(order, order.items);
    } catch (error) {
      return res.status(502).json({ error: `無法建立倉庫待揀貨紀錄：${error.message}` });
    }
  }
  const timestamp = new Date().toISOString();
  if (decision === "approve_requested" || decision === "approve_suggested") {
    order.approvedSummary = summarizeByUnit(order.items, "approvedQty");
    order.outboundOrders = warehouseFulfillment;
    order.simulatedFulfillment = UNLIMITED_CENTRAL_STOCK;
    order.status = "已核准送倉";
    order.supervisorDecision = UNLIMITED_CENTRAL_STOCK
      ? "演示模式核准（模擬出貨，未扣 WMS 實際庫存）"
      : decision === "approve_suggested" ? "依系統建議量核准" : "核准店長申請數量";
  } else if (decision === "return") {
    order.status = "待店長確認";
    order.supervisorDecision = "退回門市重新確認";
    order.managerConfirmed = false;
    order.submissionMode = "總部退回，等待門市重新確認";
    order.expiresAt = new Date(Date.now() + MANAGER_CONFIRMATION_MINUTES * 60_000).toISOString();
  } else {
    order.status = "暫緩處理";
    order.supervisorDecision = "暫緩送倉";
  }
  order.supervisor = actor;
  order.supervisorNote = supervisorNote;
  order.auditLog.push({ time: timestamp, actor, action: `${order.supervisorDecision}${order.approvedSummary == null ? "" : `（核准數量 ${order.approvedSummary}）`}`, note: supervisorNote });
  if (decision === "return") order.auditLog.push({ time: timestamp, actor: "EOS 系統", action: `訂單退回門市，等待重新確認（${MANAGER_CONFIRMATION_MINUTES} 分鐘後未確認將改採建議量）` });
  res.json(order);
});

app.post("/api/orders/:id/contact", (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "找不到此訂單。" });
  const timestamp = new Date().toISOString();
  order.contactAttempt = { time: timestamp, status: "已建立聯絡紀錄（示範模式不會實際發送訊息）" };
  order.auditLog.push({ time: timestamp, actor: "營運主管", action: "建立聯絡店長紀錄（示範）" });
  res.json(order);
});

app.post("/api/orders/:id/no-response", (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "找不到此訂單。" });
  const timestamp = new Date().toISOString();
  order.contactAttempt = { ...(order.contactAttempt || {}), time: timestamp, status: "主管聯繫無回應（示範紀錄）" };
  order.auditLog.push({ time: timestamp, actor: "營運主管", action: "記錄聯繫無回應" });
  res.json(order);
});

app.listen(PORT, () => console.log(`EOS 系統已啟動：http://localhost:${PORT}`));
