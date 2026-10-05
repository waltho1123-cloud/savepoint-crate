#!/usr/bin/env node
/**
 * 產生 tests/fixtures/n8n-golden.json（OCR 的「標準答案」）。
 *
 * 做法：把 n8n 工作流「IPAS 裝箱系統 - OCR 辨識」現行版匯出檔裡的兩個 Code 節點（『組裝請求』『解析結果』）
 * 的 jsCode 以 new Function 實際執行，記錄它對一組輸入的輸出；tests/ocr.test.ts 再拿本服務的實作逐案例比對，
 * 確保「與 n8n 現行版逐字等價」。
 *
 * 用法（匯出檔不放在 repo 裡；n8n 工作流 ID 7edM4NtAnRULFNAt，可由 n8n 介面匯出或 n8n API 取得）：
 *   node tests/fixtures/generate-n8n-golden.mjs <匯出的 live-ipas-ocr.json 路徑>
 *
 * 只有要「刻意改變辨識行為」（例如 n8n 現行版又改了 prompt）時才需要重新產生；重新產生後請檢視 git diff。
 * 本腳本只讀兩個 Code 節點的 jsCode，不會把匯出檔的其他內容（憑證 ID 等）寫進 fixture。
 */
import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error("用法：node tests/fixtures/generate-n8n-golden.mjs <n8n OCR 工作流匯出檔.json>");
  process.exit(1);
}

const live = JSON.parse(readFileSync(source, "utf8"));
const codeOf = (name) => {
  const node = live.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`匯出檔裡找不到節點：${name}`);
  return node.parameters.jsCode;
};
const assembleCode = codeOf("組裝請求");
const parseCode = codeOf("解析結果");

const run = (code, json) => new Function("$input", code)({ first: () => ({ json }) });

// n8n 回應模板："{{ $json.x }}" 會把值轉成字串塞進 JSON，前端永遠收到字串。
const templateString = (v) => {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  throw new Error("golden 案例不應出現字串／數字以外的輸出：" + JSON.stringify(v));
};

// ---- 『組裝請求』：image 輸入 → 送給 OpenAI 的 request body（或錯誤） ----
const requestInputs = [
  { name: "jpeg data URL", input: { image: "data:image/jpeg;base64,QUJDREVGRw==", boxId: "BOX-001" } },
  { name: "png data URL", input: { image: "data:image/png;base64,iVBORw0KGgo=", boxId: "BOX-002" } },
  { name: "純 base64（無 data: 前綴，mime 當 image/jpeg）", input: { image: "/9j/4AAQSkZJRgABAQ==" } },
  { name: "純 base64 含換行（n8n 照單全收）", input: { image: "QUJD\nREVG" } },
  { name: "mime 帶額外參數", input: { image: "data:image/jpeg;charset=utf-8;base64,QUJD" } },
];
const requestErrorInputs = [
  { name: "缺少 image", input: {} },
  { name: "image 為空字串", input: { image: "" } },
  { name: "data URL 缺少 ;base64,", input: { image: "data:image/jpeg,AAAA" } },
  { name: "data URL 的 base64 內含 \\n", input: { image: "data:image/jpeg;base64,AAAA\nBBBB" } },
  { name: "data URL 的 base64 內含 \\r", input: { image: "data:image/jpeg;base64,AAAA\rBBBB" } },
  { name: "data URL 的 base64 內含 U+2028", input: { image: "data:image/jpeg;base64,AAAA BBBB" } },
  { name: "data URL 的 base64 內含 U+2029", input: { image: "data:image/jpeg;base64,AAAA BBBB" } },
  { name: "data URL 的 mime 內含換行", input: { image: "data:image/\njpeg;base64,AAAA" } },
  { name: "data URL 結尾多一個換行", input: { image: "data:image/jpeg;base64,AAAA\n" } },
];

const requestCases = requestInputs.map(({ name, input }) => {
  const out = run(assembleCode, { body: input });
  return { name, input, requestBody: out[0].json.requestBody };
});
const requestErrorCases = requestErrorInputs.map(({ name, input }) => {
  try {
    run(assembleCode, { body: input });
  } catch (e) {
    return { name, input, n8nError: e.message };
  }
  throw new Error("預期 n8n 丟錯但沒有：" + name);
});

// ---- 『解析結果』：OpenAI 回傳的 content → 前端收到的五個欄位（或失敗） ----
const full = '{"barcode":"1801080204","productName":"第五代溫灸刷毛圓領發熱衣","gender":"女","color":"經典黑","size":"L"}';
const parseContents = [
  ["純 JSON", full],
  ["```json 圍欄（含換行）", "```json\n" + full + "\n```"],
  ["```json 圍欄（無換行）", '```json{"barcode":"1"}```'],
  ["``` 圍欄（無 json 標記）", "```\n" + full + "\n```"],
  ["前後有空白的圍欄", "  \n```json\n" + full + "\n```\n  "],
  ["前面有說明文字的圍欄", "結果：\n```json\n" + full + "\n```"],
  ["夾雜說明文字", '辨識結果如下：\n{"barcode":"1801472364","productName":"搖粒絨極暖衝鋒褲","gender":"男女共版","color":"星夜黑","size":"L"}\n以上。'],
  ["男女共版 → 中性", '{"barcode":"1","productName":"A","gender":"男女共版","color":"藍","size":"M"}'],
  ["性別中性維持中性", '{"barcode":"1","productName":"A","gender":"中性","color":"藍","size":"M"}'],
  ["缺欄位回空字串", '{"barcode":"123"}'],
  ["空物件", "{}"],
  ["barcode 是數字", '{"barcode":1801080204,"productName":"X"}'],
  ["欄位值為 null", '{"barcode":null,"productName":null,"gender":null,"color":null,"size":null}'],
  ["多餘欄位被忽略", '{"barcode":"1","productName":"A","gender":"男","color":"藍","size":"M","extra":"x"}'],
  ["品名內含大括號", '{"barcode":"1","productName":"A{B}","gender":"","color":"","size":""}'],
  ["CRLF 圍欄", '```json\r\n{"barcode":"1"}\r\n```'],
  ["只有開頭圍欄", '```json\n{"barcode":"1"}'],
  ["JSON 陣列（n8n 得到全空欄位）", '[{"barcode":"1"}]'],
  ["```json 圍欄內是 JSON 陣列（必須先剝圍欄，不能靠 {} 後援）", '```json\n[{"barcode":"1"}]\n```'],
  ["``` 圍欄內是 JSON 陣列（必須先剝圍欄，不能靠 {} 後援）", '```\n[{"barcode":"1"}]\n```'],
  ["JSON 字串（n8n 得到全空欄位）", '"abc"'],
  ["JSON 數字（n8n 得到全空欄位）", "5"],
  ["空字串 → 失敗", ""],
  ["純空白 → 失敗", "   "],
  ["完全沒有 JSON → 失敗", "無法辨識"],
  ["大括號內不是合法 JSON → 失敗", "{barcode: 123}"],
  ["貪婪抓取到多餘的 {} → 失敗", 'a {"barcode":"1"} b {c}'],
  ["JSON null → 失敗", "null"],
];

const parseCases = parseContents.map(([name, content]) => {
  try {
    const out = run(parseCode, { choices: [{ message: { content } }] });
    const f = out[0].json;
    return {
      name,
      content,
      expected: {
        barcode: templateString(f.barcode),
        productName: templateString(f.productName),
        gender: templateString(f.gender),
        color: templateString(f.color),
        size: templateString(f.size),
      },
    };
  } catch (e) {
    return { name, content, n8nFailed: true, n8nError: e.message };
  }
});

const golden = {
  _source:
    "由 n8n 工作流「IPAS 裝箱系統 - OCR 辨識」現行版（2026-08-05 修正版）的『組裝請求』『解析結果』兩個 Code 節點，" +
    "以 new Function 實際執行後記錄的標準答案（產生腳本：tests/fixtures/generate-n8n-golden.mjs）。" +
    "requestBody 是 n8n 實際會送給 OpenAI 的 JSON 字串；" +
    "parseCases 的 expected 是 n8n 輸出再經回應模板轉成字串後的值（n8nFailed 代表 n8n 版會丟錯）。",
  model: "gpt-5.6-luna",
  requestCases,
  requestErrorCases,
  parseCases,
};

const target = new URL("./n8n-golden.json", import.meta.url);
writeFileSync(target, JSON.stringify(golden, null, 2) + "\n");
console.log(
  `已寫入 ${target.pathname}：requestCases ${requestCases.length}、requestErrorCases ${requestErrorCases.length}、parseCases ${parseCases.length}`,
);
