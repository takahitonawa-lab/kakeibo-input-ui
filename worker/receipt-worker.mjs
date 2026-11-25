// 名和家の家計簿：レシート読み取りの作業役（自宅のパソコンで動かす）
//
// GAS に「読み取り待ちの写真はあるか」を数秒おきに聞きに行き、あればこのパソコンの Claude Code に
// 読み取らせて、結果を GAS に返す。通信はこのパソコンから外へ出るだけで、外から入る口は開けない。
// 1枚ごとに使い捨てのセッションで読み、会話の記録はディスクに残さない（--no-session-persistence）。
// 速さのため、写真はファイルにせず会話に直接入れ、Claude Code の道具・MCP・設定の読み込みも省く。
// Claude Code は API キーを渡さずに起動するので、ログイン中の契約の利用枠で動く（API の従量課金にならない）。
//
// 使い方： node worker/receipt-worker.mjs   （設定は worker/config.json。config.example.json を参照）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));
const POLL_MS = cfg.pollMs || 4000;
const CLAUDE = cfg.claudePath || "claude";
const MODEL = cfg.model || "haiku";
const TIMEOUT_MS = 150000;

const log = (...a) => console.log(new Date().toLocaleString("ja-JP"), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(action, fields = {}) {
  const fd = new FormData();
  fd.append("action", action);
  fd.append("key", cfg.key);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v ?? "");
  const res = await fetch(cfg.gasUrl, { method: "POST", body: fd, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  if (j.ok === false) throw new Error(j.error || "failed");
  return j;
}

// 分類の一覧と説明は GAS（Category_Master）から届いたものをそのまま使う
function buildPrompt(job) {
  const cats = job.cats.map(c => `- ${c.name}：${c.note || "（説明なし）"}`).join("\n");
  const n = job.image.split(",").length;
  const intro = n > 1
    ? `上の ${n}枚の画像は、1枚の長いレシートを上から順に分けて撮った写真です。1枚のレシートとしてまとめてください。写真どうしで重なって写っている行は、1回だけ数えます。`
    : "上の画像は、日本のお店のレシートの写真です。";
  return `${intro}内容を次の形の JSON だけで答えてください（前後に文章やコードブロックを付けない）。

{"store":"店名","date":"YYYY-MM-DD","total":合計金額,"items":[{"name":"品名","price":金額,"category":"分類名"}]}

ルール：
- store はお店の名前（支店名は付けない。例：「クスリのアオキ 鶴岡店」→「クスリのアオキ」）。読めなければ ""。
- date はレシートの日付。読めなければ null。今日は ${job.today} です。
- total は支払った合計金額（税込）の整数。読めなければ null。
- items には買った品物の行だけを、レシートの順に入れる。小計・合計・消費税・支払方法・お釣り・ポイントの行は入れない。
- price はその行に印字された金額の整数（円）。数量が複数なら、その行の合計。
- 値引き・割引の行は、対象の品物（ふつうは直前の行）と同じ category で、price を負の数にして入れる。
- category は、下の分類名のどれか1つを、表記どおりに入れる。迷ったら説明を読んで、いちばん近いものを選ぶ。
- 読めない行は推測で埋めず、入れない。

分類名と説明：
${cats}`;
}

function runClaude(images, prompt) {
  return new Promise((resolve, reject) => {
    // API キーを渡さない＝ログイン中の契約で動かす
    // （Claude のアプリの中から起動された場合に備えて、アプリ用の設定も引き継がない）
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE)/i.test(k)) delete env[k];
    const child = spawn(CLAUDE, ["-p", "--model", MODEL, "--tools", "", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--disable-slash-commands",
      "--system-prompt", "あなたはレシートの写真を読み取って、指示された形の JSON だけで答える係です。"],
      { cwd: os.tmpdir(), env, windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, TIMEOUT_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      const j = out.split("\n").map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).find(x => x && x.type === "result");
      if (!j) return reject(new Error("bad output: " + (err || out).slice(0, 200)));
      if (j.is_error) return reject(new Error(String(j.result || "claude error").slice(0, 200)));
      resolve(String(j.result || ""));
    });
    // 写真（base64 の JPEG）と指示を、1つのメッセージとして渡す
    const content = images.map(b64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }));
    content.push({ type: "text", text: prompt });
    child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  });
}

// Claude の答えから JSON を取り出し、形を整える（知らない分類は空にして、画面で選んでもらう）
function parseResult(text, job) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no json");
  const r = JSON.parse(text.slice(a, b + 1));
  const names = new Set(job.cats.map(c => c.name));
  const int = v => { const n = Math.round(Number(String(v ?? "").replace(/[^0-9.-]/g, ""))); return Number.isFinite(n) ? n : null; };
  const items = (Array.isArray(r.items) ? r.items : []).map(it => ({
    name: String(it?.name ?? "").slice(0, 60),
    price: int(it?.price),
    category: names.has(it?.category) ? it.category : ""
  })).filter(it => it.name && it.price !== null && it.price !== 0).slice(0, 80);
  if (!items.length) throw new Error("no items");
  const total = int(r.total);
  return {
    store: String(r.store ?? "").slice(0, 40),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) ? r.date : null,
    total: total && total > 0 ? total : null,
    items
  };
}

async function handle(job) {
  const started = Date.now();
  try {
    // 写真はディスクに書かず、メモリから直接渡す
    const text = await runClaude(job.image.split(","), buildPrompt(job));
    const result = parseResult(text, job);
    await call("worker_done", { id: job.id, result: JSON.stringify(result) });
    log(`読み取り完了：${result.items.length}行（${Math.round((Date.now() - started) / 1000)}秒）`);
  } catch (e) {
    const msg = String(e.message || e);
    const needLogin = /authenticate|OAuth|login/i.test(msg);
    log("読み取り失敗：", needLogin ? "Claude Code のログインが必要です（ターミナルで claude を起動して /login）" : msg);
    await call("worker_done", { id: job.id, error: needLogin ? "login" : msg }).catch(() => {});
  }
}

log("レシート読み取りの作業役を開始しました");
let failures = 0;
for (;;) {
  const t0 = Date.now();
  try {
    // GAS 側が写真の届くまで最大20秒待ってから答えるので、答えが来たらすぐ次を聞く
    const r = await call("worker_next");
    failures = 0;
    if (r.job) { await handle(r.job); continue; }
    if (Date.now() - t0 > 10000) continue;
  } catch (e) {
    if (++failures === 1 || failures % 30 === 0) log("GAS に接続できません：", String(e.message || e));
  }
  await sleep(failures > 5 ? 20000 : POLL_MS);
}
