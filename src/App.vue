<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";

const REFRESH_SECONDS = 45;

const params = reactive({
  symbol: "600519",
  range: "6mo",
  interval: "day",
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
  volumeMAPeriod: 20,
  volumeMultiplier: 1.35,
  stopLossPct: 6,
  autoRefresh: true
});

const status = ref("等待行情");
const errorMessage = ref("");
const isLoading = ref(false);
const lastUpdated = ref("");
const countdown = ref(REFRESH_SECONDS);
const quote = ref(null);
const analyzedRows = ref([]);
const latestSignal = ref(null);
const historySignals = ref([]);

const priceCanvas = ref(null);
const macdCanvas = ref(null);
const volumeCanvas = ref(null);

let refreshTimer = null;
let countdownTimer = null;
let requestId = 0;

const latestSignalClass = computed(() => `signal-pill ${latestSignal.value?.tone || "neutral"}`);
const scoreLabel = computed(() => latestSignal.value ? `${latestSignal.value.score}/100` : "--");
const refreshLabel = computed(() => params.autoRefresh ? `${countdown.value}s 后刷新` : "手动刷新");

const summaryCards = computed(() => {
  const latest = latestSignal.value;
  const market = quote.value;
  if (!latest || !market) {
    return [];
  }

  return [
    { label: "最新价格", value: formatNumber(latest.close, 2), note: `${latest.changePct >= 0 ? "+" : ""}${latest.changePct.toFixed(2)}%` },
    { label: "买点评分", value: scoreLabel.value, note: latest.action },
    { label: "趋势状态", value: latest.trendLabel, note: `EMA${params.fastPeriod} / EMA${params.slowPeriod}` },
    { label: "量能状态", value: latest.volumeLabel, note: `量比 ${latest.volumeRatio.toFixed(2)}x` },
    { label: "MACD", value: formatSigned(latest.macd), note: `DIF ${formatSigned(latest.dif)} / DEA ${formatSigned(latest.dea)}` },
    { label: "风险位", value: formatNumber(latest.stopLossPrice, 2), note: `${params.stopLossPct}% 止损参考` }
  ];
});

async function fetchMarketData() {
  const stock = parseChinaStockSymbol(params.symbol);
  if (!stock) {
    errorMessage.value = "请输入股票代码。";
    return;
  }
  if (params.fastPeriod >= params.slowPeriod) {
    errorMessage.value = "快线 EMA 必须小于慢线 EMA。";
    return;
  }

  const currentRequest = requestId + 1;
  requestId = currentRequest;
  isLoading.value = true;
  status.value = "获取行情中";
  errorMessage.value = "";

  try {
    const url = buildTencentKlineUrl(stock);
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error("行情源限流：腾讯证券拒绝了当前请求，请稍后重试。");
      }
      throw new Error(`行情接口返回 ${response.status}`);
    }

    const payload = await response.json();
    const rows = parseTencentKline(payload, stock);
    if (rows.length < params.slowPeriod + params.signalPeriod + 5) {
      throw new Error("行情样本不足，请调大时间范围或换成日线周期。");
    }

    if (currentRequest !== requestId) {
      return;
    }

    const enriched = analyzeRows(rows);
    const latest = evaluateBuyPoint(enriched);
    analyzedRows.value = enriched;
    latestSignal.value = latest;
    quote.value = buildQuote(payload, latest, stock);
    historySignals.value = enriched.filter((row) => row.signal !== "HOLD").slice(-20).reverse();
    status.value = "行情已更新";
    lastUpdated.value = new Date().toLocaleString("zh-CN", { hour12: false });
    countdown.value = REFRESH_SECONDS;
    nextTick(() => renderCharts(enriched));
  } catch (error) {
    errorMessage.value = error.message;
    status.value = "行情获取失败";
    latestSignal.value = null;
    quote.value = null;
    analyzedRows.value = [];
    historySignals.value = [];
    clearCharts();
  } finally {
    if (currentRequest === requestId) {
      isLoading.value = false;
    }
  }
}

function buildTencentKlineUrl(stock) {
  const paramsObject = new URLSearchParams({
    param: `${stock.tencentSymbol},day,,,${historyLimit()},qfq`
  });
  return `/api/tencent/appstock/app/fqkline/get?${paramsObject.toString()}`;
}

function parseTencentKline(payload, stock) {
  if (payload?.code !== 0) {
    throw new Error(payload?.msg || "腾讯证券行情接口返回异常。");
  }
  const stockData = payload?.data?.[stock.tencentSymbol];
  const klines = stockData?.qfqday || stockData?.day;
  if (!klines?.length) {
    throw new Error("没有获取到行情数据，请检查股票代码。");
  }

  return klines.map((line) => {
    const [date, open, close, high, low, volume] = line;
    return {
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume)
    };
  }).filter((row) => (
    row.date
    && [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
  ));
}

function buildQuote(payload, latest, stock) {
  const stockData = payload?.data?.[stock.tencentSymbol] || {};
  const qt = stockData.qt?.[stock.tencentSymbol] || [];
  return {
    symbol: `${stock.exchangeLabel}${stock.code}`,
    name: qt[1] || "--",
    exchange: stock.exchangeName,
    currency: "CNY",
    regularMarketPrice: latest.close,
    regularMarketTime: latest.date
  };
}

function parseChinaStockSymbol(input) {
  const normalized = normalizeChinaSymbol(input);
  const code = normalized.replace(/^(SH|SZ)/, "").replace(/\.(SH|SZ)$/, "");
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const market = inferChinaMarket(code, normalized);
  return {
    code,
    market,
    secid: `${market}.${code}`,
    tencentSymbol: `${market === 1 ? "sh" : "sz"}${code}`,
    exchangeLabel: market === 1 ? "SH" : "SZ",
    exchangeName: market === 1 ? "上交所" : "深交所"
  };
}

function normalizeChinaSymbol(input) {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

function inferChinaMarket(code, normalized) {
  if (normalized.startsWith("SH") || normalized.endsWith(".SH")) {
    return 1;
  }
  if (normalized.startsWith("SZ") || normalized.endsWith(".SZ")) {
    return 0;
  }
  if (/^(5|6|9|688|689)/.test(code)) {
    return 1;
  }
  return 0;
}

function historyLimit() {
  const map = {
    "1mo": "30",
    "3mo": "90",
    "6mo": "180",
    "1y": "260"
  };
  return map[params.range] || "180";
}

function analyzeRows(rows) {
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume);
  const fast = emaSeries(closes, params.fastPeriod);
  const slow = emaSeries(closes, params.slowPeriod);
  const dif = closes.map((_, index) => fast[index] - slow[index]);
  const dea = emaSeries(dif, params.signalPeriod);
  const macd = dif.map((value, index) => (value - dea[index]) * 2);
  const volumeMA = smaSeries(volumes, params.volumeMAPeriod);

  let inPosition = false;
  let entryPrice = 0;

  return rows.map((row, index) => {
    const prevDif = index > 0 ? dif[index - 1] : null;
    const prevDea = index > 0 ? dea[index - 1] : null;
    const prevClose = index > 0 ? rows[index - 1].close : row.open;
    const volumeRatio = volumeMA[index] ? row.volume / volumeMA[index] : 0;
    const goldenCross = prevDif !== null && prevDif <= prevDea && dif[index] > dea[index];
    const deathCross = prevDif !== null && prevDif >= prevDea && dif[index] < dea[index];
    const trendUp = fast[index] > slow[index] && row.close > slow[index];
    const volumeBreakout = volumeRatio >= params.volumeMultiplier;
    const stopLossTriggered = inPosition && row.close <= entryPrice * (1 - params.stopLossPct / 100);

    let signal = "HOLD";
    let note = "等待";

    if (!inPosition && goldenCross && volumeBreakout && trendUp) {
      signal = "BUY";
      note = "金叉、放量、价格站上慢线";
      inPosition = true;
      entryPrice = row.close;
    } else if (inPosition && stopLossTriggered) {
      signal = "STOP";
      note = "触发止损";
      inPosition = false;
      entryPrice = 0;
    } else if (inPosition && deathCross) {
      signal = "SELL";
      note = "MACD 死叉";
      inPosition = false;
      entryPrice = 0;
    }

    return {
      ...row,
      fast: fast[index],
      slow: slow[index],
      dif: dif[index],
      dea: dea[index],
      macd: macd[index],
      volumeMA: volumeMA[index],
      volumeRatio,
      volumeBreakout,
      trendUp,
      changePct: prevClose ? ((row.close - prevClose) / prevClose) * 100 : 0,
      signal,
      note
    };
  });
}

function evaluateBuyPoint(rows) {
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const macdRising = latest.macd > previous.macd;
  const difAboveDea = latest.dif > latest.dea;
  const nearCross = latest.dif <= latest.dea && Math.abs(latest.dif - latest.dea) <= Math.max(Math.abs(latest.close) * 0.002, 0.02);
  const priceAboveFast = latest.close > latest.fast;
  const pullbackHealthy = latest.close >= latest.slow && latest.close <= latest.fast * 1.04;
  const volumeReady = latest.volumeRatio >= params.volumeMultiplier;
  const riskDistance = ((latest.close - latest.close * (1 - params.stopLossPct / 100)) / latest.close) * 100;

  let score = 0;
  score += latest.trendUp ? 24 : 0;
  score += difAboveDea ? 18 : nearCross ? 10 : 0;
  score += macdRising ? 16 : 0;
  score += volumeReady ? 18 : latest.volumeRatio >= 1 ? 9 : 0;
  score += priceAboveFast ? 12 : 0;
  score += pullbackHealthy ? 12 : 0;
  score = Math.min(100, score);

  let action = "等待";
  let tone = "neutral";
  let reason = "信号尚未满足。";

  if (score >= 78 && volumeReady && (difAboveDea || nearCross)) {
    action = "可关注买入点";
    tone = "buy";
    reason = "趋势、MACD 和量能同时改善。";
  } else if (score >= 58) {
    action = "接近买点";
    tone = "watch";
    reason = "部分条件已满足，等待 MACD 或量能确认。";
  } else if (!latest.trendUp) {
    action = "趋势偏弱";
    tone = "sell";
    reason = "价格或快线仍在慢线下方。";
  }

  return {
    ...latest,
    score,
    action,
    tone,
    reason,
    macdRising,
    difAboveDea,
    nearCross,
    priceAboveFast,
    pullbackHealthy,
    riskDistance,
    stopLossPrice: latest.close * (1 - params.stopLossPct / 100),
    trendLabel: latest.trendUp ? "上行" : "偏弱",
    volumeLabel: volumeReady ? "放量" : latest.volumeRatio >= 1 ? "温和" : "不足"
  };
}

function renderCharts(rows) {
  drawPriceChart(rows, priceCanvas.value);
  drawMacdChart(rows, macdCanvas.value);
  drawVolumeChart(rows, volumeCanvas.value);
}

function drawPriceChart(rows, canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  clearCanvas(canvas);
  const { width, height } = canvas;
  const pad = { top: 26, right: 24, bottom: 30, left: 56 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const prices = rows.flatMap((row) => [row.close, row.fast, row.slow]);
  const minValue = Math.min(...prices) * 0.98;
  const maxValue = Math.max(...prices) * 1.02;

  drawGrid(ctx, width, height, pad, 4);
  drawLine(ctx, rows.map((row) => row.close), minValue, maxValue, pad, chartWidth, chartHeight, "#f7fafc", 2.3);
  drawLine(ctx, rows.map((row) => row.fast), minValue, maxValue, pad, chartWidth, chartHeight, "#0ea5e9", 1.7);
  drawLine(ctx, rows.map((row) => row.slow), minValue, maxValue, pad, chartWidth, chartHeight, "#f59e0b", 1.7);

  rows.forEach((row, index) => {
    if (row.signal === "HOLD") return;
    const x = pad.left + (index / (rows.length - 1)) * chartWidth;
    const y = pad.top + ((maxValue - row.close) / (maxValue - minValue)) * chartHeight;
    ctx.fillStyle = row.signal === "BUY" ? "#22c55e" : "#ef4444";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  drawLabel(ctx, `价格 / EMA${params.fastPeriod} / EMA${params.slowPeriod}`, pad.left, 18);
  drawAxis(ctx, minValue, maxValue, pad, height, (value) => formatNumber(value, 2));
}

function drawMacdChart(rows, canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  clearCanvas(canvas);
  const { width, height } = canvas;
  const pad = { top: 24, right: 24, bottom: 28, left: 56 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxAbs = Math.max(...rows.flatMap((row) => [row.macd, row.dif, row.dea]).map(Math.abs)) || 1;
  const minValue = -maxAbs * 1.2;
  const maxValue = maxAbs * 1.2;
  const zeroY = pad.top + ((maxValue - 0) / (maxValue - minValue)) * chartHeight;

  drawGrid(ctx, width, height, pad, 4);
  rows.forEach((row, index) => {
    const x = pad.left + (index / (rows.length - 1)) * chartWidth;
    const nextX = pad.left + ((index + 1) / (rows.length - 1)) * chartWidth;
    const barWidth = Math.max(2, nextX - x - 1);
    const y = pad.top + ((maxValue - row.macd) / (maxValue - minValue)) * chartHeight;
    ctx.fillStyle = row.macd >= 0 ? "rgba(34, 197, 94, 0.64)" : "rgba(239, 68, 68, 0.64)";
    ctx.fillRect(x - barWidth / 2, Math.min(zeroY, y), barWidth, Math.abs(zeroY - y));
  });
  drawLine(ctx, rows.map((row) => row.dif), minValue, maxValue, pad, chartWidth, chartHeight, "#0ea5e9", 1.8);
  drawLine(ctx, rows.map((row) => row.dea), minValue, maxValue, pad, chartWidth, chartHeight, "#f59e0b", 1.8);
  drawLabel(ctx, "MACD / DIF / DEA", pad.left, 18);
}

function drawVolumeChart(rows, canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  clearCanvas(canvas);
  const { width, height } = canvas;
  const pad = { top: 24, right: 24, bottom: 28, left: 56 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxValue = Math.max(...rows.flatMap((row) => [row.volume, row.volumeMA])) * 1.12 || 1;

  drawGrid(ctx, width, height, pad, 4);
  rows.forEach((row, index) => {
    const x = pad.left + (index / (rows.length - 1)) * chartWidth;
    const nextX = pad.left + ((index + 1) / (rows.length - 1)) * chartWidth;
    const barWidth = Math.max(2, nextX - x - 1);
    const y = pad.top + ((maxValue - row.volume) / maxValue) * chartHeight;
    ctx.fillStyle = row.volumeBreakout ? "rgba(245, 158, 11, 0.78)" : "rgba(14, 165, 233, 0.36)";
    ctx.fillRect(x - barWidth / 2, y, barWidth, height - pad.bottom - y);
  });
  drawLine(ctx, rows.map((row) => row.volumeMA), 0, maxValue, pad, chartWidth, chartHeight, "#22c55e", 1.8);
  drawLabel(ctx, `成交量 / MA${params.volumeMAPeriod}`, pad.left, 18);
  drawAxis(ctx, 0, maxValue, pad, height, formatCompact);
}

function drawGrid(ctx, width, height, pad, count) {
  ctx.strokeStyle = "rgba(15, 23, 42, 0.12)";
  ctx.lineWidth = 1;
  for (let index = 0; index <= count; index += 1) {
    const y = pad.top + ((height - pad.top - pad.bottom) / count) * index;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }
}

function drawLine(ctx, series, minValue, maxValue, pad, chartWidth, chartHeight, color, width) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  series.forEach((value, index) => {
    const x = pad.left + (index / (series.length - 1)) * chartWidth;
    const y = pad.top + ((maxValue - value) / (maxValue - minValue)) * chartHeight;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawLabel(ctx, text, x, y) {
  ctx.fillStyle = "#475569";
  ctx.font = "14px Avenir Next";
  ctx.fillText(text, x, y);
}

function drawAxis(ctx, minValue, maxValue, pad, height, formatter) {
  ctx.fillStyle = "#64748b";
  ctx.font = "12px Avenir Next";
  ctx.fillText(formatter(maxValue), 8, pad.top + 4);
  ctx.fillText(formatter((maxValue + minValue) / 2), 8, height / 2);
  ctx.fillText(formatter(minValue), 8, height - pad.bottom);
}

function clearCharts() {
  [priceCanvas.value, macdCanvas.value, volumeCanvas.value].forEach(clearCanvas);
}

function clearCanvas(canvas) {
  if (!canvas) return;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function emaSeries(values, period) {
  const multiplier = 2 / (period + 1);
  const series = [];
  let previous = values[0];
  values.forEach((value, index) => {
    if (index === 0) {
      series.push(value);
      previous = value;
      return;
    }
    const current = (value - previous) * multiplier + previous;
    series.push(current);
    previous = current;
  });
  return series;
}

function smaSeries(values, period) {
  const series = [];
  let sum = 0;
  values.forEach((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    series.push(index >= period - 1 ? sum / period : sum / (index + 1));
  });
  return series;
}

function formatNumber(value, digits) {
  return Number(value).toFixed(digits);
}

function formatSigned(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1000000000) return `${(value / 1000000000).toFixed(2)}B`;
  if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

function startTimers() {
  stopTimers();
  if (!params.autoRefresh) return;

  countdown.value = REFRESH_SECONDS;
  countdownTimer = window.setInterval(() => {
    countdown.value = Math.max(0, countdown.value - 1);
  }, 1000);
  refreshTimer = window.setInterval(fetchMarketData, REFRESH_SECONDS * 1000);
}

function stopTimers() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  if (countdownTimer) window.clearInterval(countdownTimer);
  refreshTimer = null;
  countdownTimer = null;
}

watch(
  () => [params.range, params.interval, params.fastPeriod, params.slowPeriod, params.signalPeriod, params.volumeMAPeriod, params.volumeMultiplier, params.stopLossPct],
  () => {
    if (parseChinaStockSymbol(params.symbol)) fetchMarketData();
  }
);

watch(() => params.autoRefresh, startTimers);

onMounted(() => {
  fetchMarketData();
  startTimers();
});

onUnmounted(stopTimers);
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Live Market Signal</p>
        <h1>股票买点评估</h1>
      </div>
      <div class="market-clock">
        <span>{{ status }}</span>
        <strong>{{ refreshLabel }}</strong>
      </div>
    </header>

    <main class="workspace">
      <section class="toolbar">
        <label class="symbol-box">
          <span>股票代码</span>
          <input
            v-model="params.symbol"
            placeholder="600519 / 000001 / SH600519 / 000001.SZ"
            @keyup.enter="fetchMarketData"
          >
        </label>

        <label>
          <span>周期</span>
          <select v-model="params.range">
            <option value="1mo">1个月</option>
            <option value="3mo">3个月</option>
            <option value="6mo">6个月</option>
            <option value="1y">1年</option>
          </select>
        </label>

        <label>
          <span>行情源</span>
          <select v-model="params.interval">
            <option value="day">腾讯证券 · 前复权日线</option>
          </select>
        </label>

        <button class="primary-btn" :disabled="isLoading" @click="fetchMarketData">
          {{ isLoading ? "刷新中" : "刷新行情" }}
        </button>

        <label class="toggle">
          <input v-model="params.autoRefresh" type="checkbox">
          <span>自动刷新</span>
        </label>
      </section>

      <section v-if="errorMessage" class="error-box">{{ errorMessage }}</section>

      <section v-if="quote && latestSignal" class="signal-strip">
        <div class="quote-block">
          <span>{{ quote.symbol }} · {{ quote.name }} · {{ quote.exchange }} · {{ quote.currency }}</span>
          <strong>{{ formatNumber(latestSignal.close, 2) }}</strong>
          <small>{{ latestSignal.changePct >= 0 ? "+" : "" }}{{ latestSignal.changePct.toFixed(2) }}% · {{ lastUpdated }}</small>
        </div>
        <div class="decision-block">
          <span :class="latestSignalClass">{{ latestSignal.action }}</span>
          <strong>{{ scoreLabel }}</strong>
          <small>{{ latestSignal.reason }}</small>
        </div>
      </section>

      <section class="param-panel">
        <label>
          <span>快线 EMA</span>
          <input v-model.number="params.fastPeriod" type="number" min="2" max="60">
        </label>
        <label>
          <span>慢线 EMA</span>
          <input v-model.number="params.slowPeriod" type="number" min="3" max="120">
        </label>
        <label>
          <span>信号 EMA</span>
          <input v-model.number="params.signalPeriod" type="number" min="2" max="60">
        </label>
        <label>
          <span>量能 MA</span>
          <input v-model.number="params.volumeMAPeriod" type="number" min="2" max="80">
        </label>
        <label>
          <span>放量阈值</span>
          <input v-model.number="params.volumeMultiplier" type="number" min="0.5" max="5" step="0.05">
        </label>
        <label>
          <span>止损 %</span>
          <input v-model.number="params.stopLossPct" type="number" min="1" max="30" step="0.5">
        </label>
      </section>

      <section class="summary-grid">
        <article v-for="card in summaryCards" :key="card.label" class="metric-card">
          <span>{{ card.label }}</span>
          <strong>{{ card.value }}</strong>
          <small>{{ card.note }}</small>
        </article>
      </section>

      <section class="chart-stack">
        <canvas ref="priceCanvas" width="1280" height="360"></canvas>
        <canvas ref="macdCanvas" width="1280" height="260"></canvas>
        <canvas ref="volumeCanvas" width="1280" height="220"></canvas>
      </section>

      <section class="table-section">
        <div class="section-title">
          <h2>近期触发信号</h2>
          <span>{{ analyzedRows.length }} 根K线</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>信号</th>
                <th>价格</th>
                <th>MACD</th>
                <th>量比</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!historySignals.length">
                <td colspan="6">暂无触发信号</td>
              </tr>
              <tr v-for="row in historySignals" :key="`${row.date}-${row.signal}`">
                <td>{{ row.date }}</td>
                <td :class="row.signal === 'BUY' ? 'text-buy' : 'text-sell'">{{ row.signal }}</td>
                <td>{{ formatNumber(row.close, 2) }}</td>
                <td>{{ formatSigned(row.macd) }}</td>
                <td>{{ row.volumeRatio.toFixed(2) }}x</td>
                <td>{{ row.note }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  width: min(1420px, calc(100% - 28px));
  margin: 0 auto;
  padding: 22px 0 44px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 18px;
  padding: 18px 0;
  border-bottom: 1px solid rgba(15, 23, 42, 0.12);
}

.eyebrow {
  margin: 0 0 6px;
  color: #0f766e;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

h1,
h2 {
  margin: 0;
  color: #0f172a;
}

h1 {
  font-size: 32px;
}

.market-clock {
  display: grid;
  gap: 4px;
  text-align: right;
  color: #64748b;
}

.market-clock strong {
  color: #0f172a;
}

.workspace {
  display: grid;
  gap: 16px;
  padding-top: 18px;
}

.toolbar,
.param-panel,
.signal-strip,
.summary-grid,
.chart-stack,
.table-section,
.error-box {
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.08);
}

.toolbar {
  display: grid;
  grid-template-columns: minmax(240px, 2fr) minmax(120px, 0.8fr) minmax(120px, 0.8fr) auto auto;
  gap: 12px;
  align-items: end;
  padding: 14px;
}

label {
  display: grid;
  gap: 6px;
  color: #475569;
  font-size: 13px;
}

input,
select,
button {
  height: 42px;
  border-radius: 6px;
  font: inherit;
}

input,
select {
  width: 100%;
  border: 1px solid #cbd5e1;
  color: #0f172a;
  background: #ffffff;
  padding: 0 12px;
}

.symbol-box input {
  font-size: 18px;
  font-weight: 700;
  text-transform: uppercase;
}

button {
  border: 0;
  padding: 0 16px;
  cursor: pointer;
  font-weight: 700;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.primary-btn {
  color: #ffffff;
  background: #0f766e;
}

.toggle {
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  height: 42px;
}

.toggle input {
  width: 18px;
  height: 18px;
}

.error-box {
  padding: 14px 16px;
  color: #991b1b;
  background: #fef2f2;
  border-color: #fecaca;
}

.signal-strip {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 16px;
}

.quote-block,
.decision-block {
  display: grid;
  gap: 8px;
}

.quote-block span,
.decision-block small,
.quote-block small,
.metric-card span,
.metric-card small,
.section-title span {
  color: #64748b;
}

.quote-block strong,
.decision-block strong {
  font-size: 38px;
  line-height: 1;
  color: #0f172a;
}

.signal-pill {
  width: fit-content;
  padding: 6px 10px;
  border-radius: 6px;
  font-weight: 800;
}

.signal-pill.buy {
  color: #166534;
  background: #dcfce7;
}

.signal-pill.watch {
  color: #92400e;
  background: #fef3c7;
}

.signal-pill.sell {
  color: #991b1b;
  background: #fee2e2;
}

.signal-pill.neutral {
  color: #334155;
  background: #e2e8f0;
}

.param-panel {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  padding: 14px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  background: rgba(15, 23, 42, 0.12);
}

.metric-card {
  display: grid;
  gap: 8px;
  min-height: 116px;
  padding: 14px;
  background: #ffffff;
}

.metric-card strong {
  color: #0f172a;
  font-size: 28px;
}

.chart-stack {
  display: grid;
  gap: 10px;
  padding: 12px;
}

canvas {
  width: 100%;
  height: auto;
  border: 1px solid rgba(15, 23, 42, 0.1);
  border-radius: 6px;
  background: #ffffff;
}

.table-section {
  padding: 14px;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.section-title h2 {
  font-size: 18px;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 12px 10px;
  border-bottom: 1px solid #e2e8f0;
  text-align: left;
  white-space: nowrap;
}

th {
  color: #475569;
  font-size: 13px;
}

td {
  color: #0f172a;
}

.text-buy {
  color: #15803d;
  font-weight: 800;
}

.text-sell {
  color: #dc2626;
  font-weight: 800;
}

@media (max-width: 980px) {
  .toolbar,
  .param-panel,
  .summary-grid,
  .signal-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .primary-btn,
  .toggle {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .app-shell {
    width: min(100% - 18px, 1420px);
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .market-clock {
    text-align: left;
  }

  .toolbar,
  .param-panel,
  .summary-grid,
  .signal-strip {
    grid-template-columns: 1fr;
  }

  .quote-block strong,
  .decision-block strong {
    font-size: 32px;
  }
}
</style>
