#!/bin/bash
# =============================================================
#  Аудит TON-блокчейна (blockchain-first)
#
#  Проверки:
#    • Метрики здоровья (статусы, время доставки, recycle-гистограмма)
#    • Двойные доставки в БД (один payment_id → несколько COMPLETED)
#    • tx_hash без ton_comment (потерянные комментарии)
#    • Дубли комментариев в блокчейне (один коммент >1 раза)
#    • Дубли-ретраи (prev_ton_comments + ton_comment, оба ушли в чейн)
#    • Сироты в блокчейне (комменты, которых нет в БД)
#    • Денежный ущерб в TON
#
#  Запуск:
#    ./scripts/blockchain-audit.sh          # последние 48 часов
#    ./scripts/blockchain-audit.sh 24       # последние 24 часа
#    ./scripts/blockchain-audit.sh 168      # последние 7 дней
#
#  Опции окружения:
#    NO_COLOR=1   отключить ANSI-цвета
# =============================================================

HOURS="${1:-48}"
NAMESPACE="stars-bot"
STARS_POD=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=stars-bot --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')

if [ -z "$STARS_POD" ]; then
  echo "❌ Pod не найден"
  exit 1
fi

echo "📦 Pod: $STARS_POD"

kubectl exec -it "$STARS_POD" -n "$NAMESPACE" -- node -e '
const { PrismaClient } = require("@prisma/client");
const https = require("https");

const HOURS = parseInt(process.argv[1]) || 48;
const SINCE = new Date(Date.now() - HOURS * 3600 * 1000);
const sinceUnix = Math.floor(SINCE.getTime() / 1000);
const apiKey = (process.env.TONCENTER_API_KEY || "").split(",")[0].trim();
const walletAddr = process.env.WALLET_ADDRESS || "";

// ─── ANSI ──────────────────────────────────────────────────
const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const c = (code, s) => useColor ? "\x1b[" + code + "m" + s + "\x1b[0m" : s;
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const blue = (s) => c("34", s);
const cyan = (s) => c("36", s);
const gray = (s) => c("90", s);

const BAR = "═".repeat(63);
const SUB = "─".repeat(63);

const section = (title) => {
  console.log("");
  console.log(cyan(BAR));
  console.log(cyan("  " + title));
  console.log(cyan(BAR));
  console.log("");
};

const subsection = (title) => {
  console.log("");
  console.log(bold(title));
  console.log(dim(SUB));
};

const fmtTon = (nano) => (Number(nano || 0) / 1e9).toFixed(4) + " TON";
const fmtDate = (d) => d ? new Date(d).toISOString().substring(0, 19).replace("T", " ") : "?";
const fmtDuration = (sec) => {
  if (sec < 60) return sec.toFixed(0) + "s";
  if (sec < 3600) return (sec / 60).toFixed(1) + "m";
  return (sec / 3600).toFixed(1) + "h";
};
const productOf = (r) => r.stars ? "⭐" + r.stars
  : r.premium ? "💎Premium"
  : r.ton ? "💎" + r.ton + " TON" : "?";

// ─── HTTP ──────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error("HTTP " + res.statusCode + ": " + data.slice(0, 120).replace(/\n/g, " ")));
        }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON parse (HTTP " + res.statusCode + "): " + data.slice(0, 80).replace(/\n/g, " "))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, retries = 4, baseDelayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchJSON(url);
    } catch(e) {
      if (attempt === retries) throw e;
      const wait = baseDelayMs * attempt;
      process.stdout.write("\r  " + yellow("⏳ Ошибка API (" + attempt + "/" + retries + "), повтор через " + (wait/1000) + "с: ") + e.message.slice(0, 60) + "    ");
      await sleep(wait);
    }
  }
}

// ─── BoC decoder (snake-format text) ───────────────────────
function extractTextFromBoc(base64Boc) {
  try {
    const buf = Buffer.from(base64Boc, "base64");
    if (buf.length < 10) return null;
    if (buf[0] !== 0xb5 || buf[1] !== 0xee || buf[2] !== 0x9c || buf[3] !== 0x72) return null;
    const flags = buf[4];
    const refByteSize = flags & 7;
    if (refByteSize === 0) return null;
    const offsetByteSize = buf[5];
    let pos = 6;
    let cellCount = 0;
    for (let i = 0; i < refByteSize; i++) cellCount = cellCount * 256 + buf[pos++];
    let rootCount = 0;
    for (let i = 0; i < refByteSize; i++) rootCount = rootCount * 256 + buf[pos++];
    pos += refByteSize;
    pos += offsetByteSize;
    pos += rootCount * refByteSize;
    if ((flags >> 7) & 1) pos += cellCount * offsetByteSize;

    const cells = [];
    for (let c = 0; c < cellCount; c++) {
      const d1 = buf[pos++];
      const d2 = buf[pos++];
      const refCount = d1 & 7;
      const dataByteLen = Math.ceil(d2 / 2);
      const data = buf.slice(pos, pos + dataByteLen);
      pos += dataByteLen;
      const refs = [];
      for (let r = 0; r < refCount; r++) {
        let refIdx = 0;
        for (let i = 0; i < refByteSize; i++) refIdx = refIdx * 256 + buf[pos++];
        refs.push(refIdx);
      }
      cells.push({ data, refs, dataByteLen });
    }

    if (cells.length === 0) return null;
    const root = cells[0];
    if (root.dataByteLen < 5) return null;
    if (root.data.readUInt32BE(0) !== 0) return null;

    let text = root.data.slice(4).toString("utf8");
    let current = root;
    while (current.refs.length > 0) {
      const nextIdx = current.refs[0];
      if (nextIdx >= cells.length) break;
      current = cells[nextIdx];
      text += current.data.toString("utf8");
    }
    return text;
  } catch(e) {
    return null;
  }
}

(async () => {
  const tStart = Date.now();
  const prisma = new PrismaClient();

  console.log("");
  console.log(bold("🔍 АУДИТ TON-БЛОКЧЕЙНА"));
  console.log(dim("   Период: за последние " + HOURS + "ч (с " + fmtDate(SINCE) + " UTC)"));
  console.log("");

  // ─── 0. HEALTH METRICS ─────────────────────────────────────
  section("МЕТРИКИ ЗДОРОВЬЯ ОЧЕРЕДИ (за " + HOURS + "ч)");

  const allInWindow = await prisma.fragmentQueue.findMany({
    where: { created_at: { gte: SINCE } },
    select: {
      id: true, status: true, created_at: true, updated_at: true,
      retry_count: true, prev_ton_comments: true, blockchain_miss_count: true,
    },
  });

  const byStatus = new Map();
  for (const it of allInWindow) {
    byStatus.set(it.status, (byStatus.get(it.status) || 0) + 1);
  }

  const statusOrder = ["COMPLETED", "PENDING", "PROCESSING", "FAILED"];
  const statusEmoji = { COMPLETED: "✅", PENDING: "⏳", PROCESSING: "🔄", FAILED: "❌" };
  const statusColor = { COMPLETED: green, PENDING: blue, PROCESSING: yellow, FAILED: red };

  console.log("  " + bold("Статусы:"));
  for (const st of statusOrder) {
    const n = byStatus.get(st) || 0;
    if (n === 0) continue;
    const pct = ((n / allInWindow.length) * 100).toFixed(1);
    console.log("    " + statusEmoji[st] + "  " + statusColor[st](st.padEnd(10)) + " " + String(n).padStart(5) + dim("  (" + pct + "%)"));
  }
  for (const [st, n] of byStatus) {
    if (statusOrder.includes(st)) continue;
    console.log("    •  " + st.padEnd(10) + " " + String(n).padStart(5));
  }
  console.log("");

  const completed = allInWindow.filter(x => x.status === "COMPLETED");
  const successRate = allInWindow.length > 0
    ? ((completed.length / allInWindow.length) * 100).toFixed(2)
    : "n/a";

  console.log("  " + bold("Доставка:"));
  console.log("    Всего ордеров   : " + bold(String(allInWindow.length)));
  console.log("    Доставлено      : " + green(String(completed.length)) + dim(" (" + successRate + "%)"));

  // время доставки (created → updated) для COMPLETED
  if (completed.length > 0) {
    const durations = completed
      .map(x => (x.updated_at.getTime() - x.created_at.getTime()) / 1000)
      .filter(d => d > 0)
      .sort((a, b) => a - b);

    if (durations.length > 0) {
      const median = durations[Math.floor(durations.length / 2)];
      const p95 = durations[Math.floor(durations.length * 0.95)];
      const p99 = durations[Math.floor(durations.length * 0.99)];
      const max = durations[durations.length - 1];
      const longDeliveries = durations.filter(d => d > 300).length;

      console.log("    Медиана         : " + fmtDuration(median));
      console.log("    p95             : " + fmtDuration(p95));
      console.log("    p99             : " + fmtDuration(p99));
      console.log("    Максимум        : " + (max > 600 ? red(fmtDuration(max)) : fmtDuration(max)));
      console.log("    " + (longDeliveries > 0 ? yellow : green)("Долгие (>5 мин) : " + longDeliveries));
    }
  }
  console.log("");

  // recycle-гистограмма
  const recycleCounts = new Map();
  let withRecycle = 0;
  for (const it of allInWindow) {
    const n = (it.prev_ton_comments || []).length;
    recycleCounts.set(n, (recycleCounts.get(n) || 0) + 1);
    if (n > 0) withRecycle++;
  }

  console.log("  " + bold("Recycle (prev_ton_comments):"));
  if (withRecycle === 0) {
    console.log("    " + green("✅ Ни одного recycle"));
  } else {
    console.log("    Затронуто ордеров: " + (withRecycle > 5 ? red : yellow)(String(withRecycle)) + dim(" из " + allInWindow.length));
    const maxN = Math.max(...recycleCounts.keys());
    const maxBarWidth = 40;
    const maxCount = Math.max(...[...recycleCounts.entries()].filter(([k]) => k > 0).map(([, v]) => v));
    for (let n = 1; n <= maxN; n++) {
      const cnt = recycleCounts.get(n) || 0;
      if (cnt === 0) continue;
      const barLen = Math.max(1, Math.round((cnt / maxCount) * maxBarWidth));
      const bar = "█".repeat(barLen);
      const color = n >= 3 ? red : n === 2 ? yellow : blue;
      console.log("    " + n + "× recycle: " + String(cnt).padStart(4) + "  " + color(bar));
    }
  }
  console.log("");

  // retry_count распределение
  const retryDist = new Map();
  for (const it of allInWindow) {
    const r = it.retry_count || 0;
    retryDist.set(r, (retryDist.get(r) || 0) + 1);
  }
  if (retryDist.size > 1) {
    console.log("  " + bold("retry_count:"));
    const total = allInWindow.length;
    for (const r of [...retryDist.keys()].sort((a, b) => a - b)) {
      const cnt = retryDist.get(r);
      const pct = ((cnt / total) * 100).toFixed(1);
      console.log("    " + String(r).padStart(2) + " ретраев: " + String(cnt).padStart(5) + dim(" (" + pct + "%)"));
    }
    console.log("");
  }

  // ─── 1. Двойные доставки в БД ──────────────────────────────
  section("ПРОВЕРКА 1: Двойные доставки (один payment_id → несколько COMPLETED)");

  const allCompleted = await prisma.fragmentQueue.findMany({
    where: { status: "COMPLETED", payment_id: { not: null }, created_at: { gte: SINCE } },
    select: {
      id: true, payment_id: true, username: true,
      stars: true, ton: true, premium: true,
      tx_hash: true, ton_amount: true, created_at: true,
      payment: { select: { order_number: true } },
    },
  });

  const byPayment = new Map();
  for (const item of allCompleted) {
    const pid = item.payment_id;
    if (!byPayment.has(pid)) byPayment.set(pid, []);
    byPayment.get(pid).push(item);
  }

  let doubleCount = 0;
  for (const [pid, items] of byPayment) {
    if (items.length <= 1) continue;
    doubleCount++;
    const order = items[0].payment?.order_number || "?";
    console.log("  " + red("🔴 Заказ #" + order) + " — " + items.length + " доставок " + dim("(payment_id: " + pid + ")"));
    for (const it of items) {
      const txLink = it.tx_hash ? "https://tonviewer.com/transaction/" + it.tx_hash : dim("(нет tx)");
      console.log("     → @" + it.username + " | " + productOf(it) + " | " + fmtDate(it.created_at));
      console.log("       " + dim(txLink));
    }
    console.log("");
  }

  if (doubleCount === 0) {
    console.log("  " + green("✅ Двойных доставок не найдено"));
  } else {
    console.log("  " + red("⚠️  Заказов с дублями: " + doubleCount));
  }
  console.log("");

  // ─── 1b. Записи с tx_hash но без ton_comment ─────────────────
  section("ПРОВЕРКА 1b: Записи с tx_hash, но без ton_comment");

  const lostComments = await prisma.fragmentQueue.findMany({
    where: {
      tx_hash: { not: null },
      created_at: { gte: SINCE },
      OR: [{ ton_comment: null }, { ton_comment: "" }],
    },
    select: {
      id: true, username: true, stars: true, premium: true, ton: true,
      tx_hash: true, ton_amount: true, status: true, created_at: true,
      prev_ton_comments: true,
      payment: { select: { order_number: true } },
    },
    orderBy: { created_at: "desc" },
  });

  if (lostComments.length === 0) {
    console.log("  " + green("✅ Все записи с tx_hash имеют ton_comment"));
  } else {
    const withPrev = lostComments.filter(r => r.prev_ton_comments && r.prev_ton_comments.length > 0);
    const withoutAny = lostComments.filter(r => !r.prev_ton_comments || r.prev_ton_comments.length === 0);
    console.log("  " + yellow("⚠️  Найдено: " + lostComments.length));
    console.log("     С prev_ton_comments : " + withPrev.length + dim(" (комментарий был, ушёл в архив при ретрае)"));
    console.log("     Без комментария    : " + (withoutAny.length > 0 ? red(String(withoutAny.length)) : String(withoutAny.length)) + dim(" (потерян, требует расследования)"));

    if (withoutAny.length > 0) {
      console.log("");
      console.log("  " + red("🔴 Записи БЕЗ комментария:"));
      for (const r of withoutAny.slice(0, 20)) {
        const order = r.payment?.order_number || "?";
        console.log("    → @" + (r.username || "?") + " | " + productOf(r) + " | " + r.status + " | order #" + order + " | " + fmtDate(r.created_at));
        console.log("      " + dim("tx: https://tonviewer.com/transaction/" + r.tx_hash));
        if (r.ton_amount) console.log("      " + dim("amount: " + (Number(r.ton_amount) / 1e9).toFixed(4) + " TON"));
      }
      if (withoutAny.length > 20) console.log("    " + dim("... и ещё " + (withoutAny.length - 20)));
    }
  }
  console.log("");

  // ─── 2. Блокчейн → БД: сравнение комментариев ──────────────
  section("ПРОВЕРКА 2: Сравнение блокчейн ↔ БД");

  // 2a. БД-комменты (ИСПРАВЛЕНО: фильтр по updated_at в окно, чтобы не сравнивать
  // с блокчейн-окном старые записи и не получать ложных "сирот")
  subsection("📦 Загружаем ton_comment из БД");
  const allDbItems = await prisma.fragmentQueue.findMany({
    where: {
      status: "COMPLETED",
      OR: [
        { updated_at: { gte: SINCE } },
        { created_at: { gte: SINCE } },
      ],
    },
    select: {
      id: true, ton_comment: true, prev_ton_comments: true, tx_hash: true,
      username: true, stars: true, premium: true, ton: true,
      created_at: true, updated_at: true,
      payment: { select: { order_number: true } },
    },
  });

  const dbCommentSet = new Set();
  let decodeOk = 0;
  let decodeFail = 0;

  for (const item of allDbItems) {
    if (item.ton_comment) {
      const text = extractTextFromBoc(item.ton_comment);
      if (text) { dbCommentSet.add(text); decodeOk++; }
      else { decodeFail++; }
    }
    if (item.prev_ton_comments && item.prev_ton_comments.length > 0) {
      for (const prev of item.prev_ton_comments) {
        const text = extractTextFromBoc(prev);
        if (text) { dbCommentSet.add(text); decodeOk++; }
        else { decodeFail++; }
      }
    }
  }

  console.log("  БД записей в окне    : " + bold(String(allDbItems.length)));
  console.log("  Уникальных комментов : " + bold(String(dbCommentSet.size)));
  console.log("  Декодировано         : " + green(String(decodeOk)) + dim("  (не удалось: " + decodeFail + ")"));

  // 2b. Блокчейн
  subsection("📡 Загружаем транзакции из блокчейна");

  let walletRaw = "";
  if (walletAddr) {
    try {
      const { Address } = require("@ton/core");
      walletRaw = Address.parse(walletAddr).toRawString();
    } catch(e) {
      walletRaw = walletAddr;
    }
  }
  if (!walletRaw) {
    console.log("  " + dim("WALLET_ADDRESS не задан, определяем из БД…"));
    const knownTx = await prisma.fragmentQueue.findFirst({
      where: { status: "COMPLETED", tx_hash: { not: null } },
      select: { tx_hash: true },
      orderBy: { updated_at: "desc" },
    });
    if (knownTx) {
      const hashB64 = Buffer.from(knownTx.tx_hash, "hex").toString("base64");
      const txData = await fetchWithRetry(
        "https://toncenter.com/api/v3/transactions?hash=" + encodeURIComponent(hashB64) + "&limit=1&api_key=" + apiKey
      );
      walletRaw = (txData.transactions || [])[0]?.account || "";
    }
  }

  if (!walletRaw) {
    console.log("  " + red("❌ Не удалось определить адрес кошелька"));
    await prisma.$disconnect();
    return;
  }

  console.log("  Кошелёк : " + bold(walletRaw));
  console.log("");

  const PAGE_SIZE = 256;
  let offset = 0;
  let totalFetched = 0;
  const blockchainComments = [];
  const seenMsgs = new Set();
  let reachedEnd = false;
  const tFetchStart = Date.now();

  while (!reachedEnd) {
    const url = "https://toncenter.com/api/v3/transactions"
      + "?account=" + encodeURIComponent(walletRaw)
      + "&limit=" + PAGE_SIZE
      + "&offset=" + offset
      + "&sort=desc"
      + "&api_key=" + apiKey;

    let data;
    try {
      data = await fetchWithRetry(url);
    } catch(e) {
      console.log("\r  " + red("❌ Ошибка API после всех попыток: ") + e.message);
      break;
    }

    if (data.error) {
      console.log("  " + red("⚠️  API error: " + data.error));
      break;
    }

    const txs = data.transactions || [];
    if (txs.length === 0) break;

    for (const tx of txs) {
      const txTime = Number(tx.now || 0);
      if (txTime < sinceUnix) {
        reachedEnd = true;
        break;
      }

      const txHashHex = Buffer.from(tx.hash, "base64").toString("hex");

      for (const msg of (tx.out_msgs || [])) {
        if (msg.opcode !== "0x00000000") continue;
        if (msg.destination === walletRaw) continue;

        const comment = msg.message_content && msg.message_content.decoded && msg.message_content.decoded.comment;
        if (!comment) continue;

        const dedupeKey = txHashHex + "|" + comment + "|" + (msg.destination || "");
        if (seenMsgs.has(dedupeKey)) continue;
        seenMsgs.add(dedupeKey);

        blockchainComments.push({
          comment,
          txHash: txHashHex,
          destination: msg.destination,
          value: msg.value,
          createdAt: tx.now,
        });
      }
      totalFetched++;
    }

    offset += txs.length;
    process.stdout.write("\r  транзакций: " + totalFetched + " | комментариев: " + blockchainComments.length + dim("  (" + ((Date.now() - tFetchStart) / 1000).toFixed(1) + "с)"));
    await sleep(300);
  }

  process.stdout.write("\r" + " ".repeat(80) + "\r");
  console.log("  Транзакций       : " + bold(String(totalFetched)));
  console.log("  Out-комментариев : " + bold(String(blockchainComments.length)));
  console.log("  Время сбора      : " + dim(((Date.now() - tFetchStart) / 1000).toFixed(1) + "с"));

  // 2c. Дубли в блокчейне (один комментарий >1 раза)
  const commentCountMap = new Map();
  for (const bc of blockchainComments) {
    if (!commentCountMap.has(bc.comment)) commentCountMap.set(bc.comment, []);
    commentCountMap.get(bc.comment).push(bc);
  }

  const blockchainDupes = [];
  for (const [comment, items] of commentCountMap) {
    if (items.length > 1) blockchainDupes.push({ comment, items });
  }

  // 2d. Двойная отправка с РАЗНЫМИ комментариями (retry-dupes)
  const blockchainCommentMap = new Map();
  for (const bc of blockchainComments) {
    if (!blockchainCommentMap.has(bc.comment)) blockchainCommentMap.set(bc.comment, bc);
  }
  const retryDupes = [];

  for (const item of allDbItems) {
    const allComments = [];
    if (item.ton_comment) {
      const t = extractTextFromBoc(item.ton_comment);
      if (t) allComments.push(t);
    }
    if (item.prev_ton_comments && item.prev_ton_comments.length > 0) {
      for (const p of item.prev_ton_comments) {
        const t = extractTextFromBoc(p);
        if (t) allComments.push(t);
      }
    }
    if (allComments.length < 2) continue;

    const sentToChain = allComments.filter(c => blockchainCommentMap.has(c));
    if (sentToChain.length > 1) {
      let totalTon = 0;
      for (const c of sentToChain) {
        const bc = blockchainCommentMap.get(c);
        if (bc) totalTon += Number(bc.value || 0) / 1e9;
      }
      const perSend = totalTon / sentToChain.length;
      const extraTon = perSend * (sentToChain.length - 1);

      retryDupes.push({
        username: item.username,
        stars: item.stars,
        premium: item.premium,
        ton: item.ton,
        tx_hash: item.tx_hash,
        order: item.payment?.order_number,
        sentCount: sentToChain.length,
        sentComments: sentToChain,
        sentTxs: sentToChain.map(c => blockchainCommentMap.get(c)),
        totalTon,
        extraTon,
      });
    }
  }

  // 2e. Сироты (комменты в блокчейне, которых нет в БД)
  let matched = 0;
  const notInDb = [];

  for (const bc of blockchainComments) {
    if (dbCommentSet.has(bc.comment)) {
      matched++;
    } else {
      notInDb.push(bc);
    }
  }

  // ─── Сводная таблица проверки 2 ────────────────────────────
  subsection("📊 Результат сравнения");
  const fmtRow = (label, n, color = null) => {
    const numStr = String(n).padStart(5);
    const colored = color ? color(numStr) : (n > 0 ? yellow(numStr) : green(numStr));
    return "    " + label.padEnd(45) + " " + colored;
  };
  console.log(fmtRow("✅ Совпадают с БД", matched, n => n > 0 ? green(String(n).padStart(5)) : String(n).padStart(5)));
  console.log(fmtRow("❌ Не найдены в БД (сироты)", notInDb.length, n => n > 0 ? red(String(n).padStart(5)) : green(String(n).padStart(5))));
  console.log(fmtRow("🔁 Дублей одного коммента (>1 раза)", blockchainDupes.length, n => n > 0 ? red(String(n).padStart(5)) : green(String(n).padStart(5))));
  console.log(fmtRow("🔁 Дублей-ретраев (prev + cur, оба ушли)", retryDupes.length, n => n > 0 ? red(String(n).padStart(5)) : green(String(n).padStart(5))));
  console.log("");

  // ─── Детали ────────────────────────────────────────────────
  if (blockchainDupes.length > 0) {
    subsection("🔁 Дубли в блокчейне (один комментарий отправлен несколько раз)");
    for (const dupe of blockchainDupes.slice(0, 20)) {
      const tonPerItem = (Number(dupe.items[0].value) / 1e9).toFixed(4);
      const totalTon = dupe.items.reduce((s, i) => s + Number(i.value), 0) / 1e9;
      console.log("  " + red("🔴 \"" + dupe.comment.replace(/\n/g, "\\n").substring(0, 60) + "\""));
      console.log("     " + dupe.items.length + " отправок × " + tonPerItem + " = " + bold(totalTon.toFixed(4) + " TON"));
      for (const item of dupe.items) {
        console.log("     → " + fmtDate(Number(item.createdAt) * 1000) + dim("  https://tonviewer.com/transaction/" + item.txHash));
      }
      console.log("");
    }
    if (blockchainDupes.length > 20) console.log("  " + dim("... и ещё " + (blockchainDupes.length - 20)));
  }

  if (retryDupes.length > 0) {
    subsection("🔁 Двойные отправки (ретрай: prev_ton_comments + текущий, оба в чейне)");
    for (const rd of retryDupes.slice(0, 30)) {
      console.log("  " + red("🔴 @" + (rd.username || "?")) + " | " + productOf(rd) + " | order #" + (rd.order || "?"));
      console.log("     " + rd.sentCount + " отправок | итого: " + bold(rd.totalTon.toFixed(4) + " TON") + " | " + red("лишних: " + rd.extraTon.toFixed(4) + " TON"));
      for (let i = 0; i < rd.sentComments.length; i++) {
        const tx = rd.sentTxs[i];
        const date = tx ? fmtDate(Number(tx.createdAt) * 1000) : "?";
        console.log("     " + dim((i === rd.sentComments.length - 1 ? "└" : "├") + " ") + date + dim("  ") + rd.sentComments[i].replace(/\n/g, "\\n").substring(0, 40));
        if (tx) console.log("     " + dim((i === rd.sentComments.length - 1 ? " " : "│") + "   https://tonviewer.com/transaction/" + tx.txHash));
      }
      console.log("");
    }
    if (retryDupes.length > 30) console.log("  " + dim("... и ещё " + (retryDupes.length - 30)));
  }

  if (notInDb.length > 0) {
    subsection("⚠️  Сироты: комменты в блокчейне, которых нет в БД");
    const debugCount = Math.min(10, notInDb.length);
    for (let idx = 0; idx < debugCount; idx++) {
      const bc = notInDb[idx];
      const tonAmount = (Number(bc.value) / 1e9).toFixed(4);
      console.log("  " + red("🔴 \"" + bc.comment.replace(/\n/g, "\\n").substring(0, 60) + "\""));
      console.log("     " + tonAmount + " TON | " + fmtDate(Number(bc.createdAt) * 1000));
      console.log("     " + dim("https://tonviewer.com/transaction/" + bc.txHash));

      // ищем по tx_hash в БД
      const dbRows = await prisma.fragmentQueue.findMany({
        where: { tx_hash: bc.txHash },
        select: { id: true, ton_comment: true, prev_ton_comments: true, status: true, username: true, stars: true, premium: true, ton: true },
      });
      if (dbRows.length === 0) {
        console.log("     " + yellow("БД по tx_hash: НЕТ записей"));
      } else {
        for (const row of dbRows) {
          const decoded = row.ton_comment ? extractTextFromBoc(row.ton_comment) : null;
          const prevCount = (row.prev_ton_comments || []).length;
          console.log("     " + dim("БД: @" + row.username + " | " + productOf(row) + " | " + row.status + " | prev: " + prevCount));
          if (decoded) console.log("     " + dim("    decoded: " + decoded.substring(0, 50)));
        }
      }
      console.log("");
    }
    if (notInDb.length > debugCount) console.log("  " + dim("... и ещё " + (notInDb.length - debugCount)));
  }

  // ─── ФИНАЛЬНЫЙ ВЕРДИКТ ─────────────────────────────────────
  section("ВЕРДИКТ (период: " + fmtDate(SINCE) + " → " + fmtDate(new Date()) + " UTC)");

  const lostCount = lostComments.filter(r => !r.prev_ton_comments || r.prev_ton_comments.length === 0).length;
  const issues = doubleCount + notInDb.length + blockchainDupes.length + retryDupes.length + lostCount;

  // подсчёт ущерба в TON
  let damageDupes = 0;
  for (const [, items] of commentCountMap) {
    if (items.length > 1) {
      for (let i = 1; i < items.length; i++) {
        damageDupes += Number(items[i].value || 0) / 1e9;
      }
    }
  }
  let damageRetry = 0;
  for (const rd of retryDupes) damageRetry += rd.extraTon;
  let damageNotInDb = 0;
  for (const bc of notInDb) damageNotInDb += Number(bc.value || 0) / 1e9;

  const totalDamage = damageDupes + damageRetry + damageNotInDb;
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);

  if (issues === 0) {
    console.log("  " + green("✅ Всё чисто. Никаких аномалий не обнаружено."));
    console.log("");
    console.log("     • Двойных доставок (БД)              : " + green("0"));
    console.log("     • Потерянных комментариев            : " + green("0"));
    console.log("     • Дублей в блокчейне                 : " + green("0"));
    console.log("     • Дублей-ретраев (двойные отправки)  : " + green("0"));
    console.log("     • Сирот (чейн без БД)                : " + green("0"));
    console.log("     • " + bold("💰 Денежный ущерб") + "                     : " + green("0 TON"));
    console.log("");
    console.log("     " + dim("Проверено: " + totalFetched + " транзакций, " + blockchainComments.length + " out-комментариев"));
  } else {
    console.log("  " + red("⚠️  Обнаружено проблем: " + issues));
    console.log("");
    if (doubleCount > 0)            console.log("     • Двойных доставок (БД)              : " + red(String(doubleCount).padStart(4)));
    if (lostCount > 0)              console.log("     • Потерянных комментариев            : " + red(String(lostCount).padStart(4)));
    if (blockchainDupes.length > 0) console.log("     • Дублей в блокчейне (один коммент)  : " + red(String(blockchainDupes.length).padStart(4)) + dim("  (~" + damageDupes.toFixed(4) + " TON)"));
    if (retryDupes.length > 0)      console.log("     • Дублей-ретраев (prev + cur)        : " + red(String(retryDupes.length).padStart(4)) + dim("  (~" + damageRetry.toFixed(4) + " TON)"));
    if (notInDb.length > 0)         console.log("     • Сирот (чейн без БД)                : " + red(String(notInDb.length).padStart(4)) + dim("  (~" + damageNotInDb.toFixed(4) + " TON)"));
    console.log("");
    console.log("  " + bold("💰 ОБЩИЙ УЩЕРБ: ~") + (totalDamage > 0 ? red(totalDamage.toFixed(4) + " TON") : green("0 TON")));
  }

  console.log("");
  console.log(dim("  Аудит завершён за " + elapsed + "с"));
  console.log("");

  await prisma.$disconnect();
})().catch(e => { console.error(red("❌ " + e.message)); process.exit(1); });
' -- "$HOURS"
