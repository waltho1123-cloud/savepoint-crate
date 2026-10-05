import { describeError, readJsonSafely, ServiceError, type FetchLike, type Logger } from "./common.js";

/**
 * 拍照辨識（OCR）：原 n8n 工作流「IPAS 裝箱系統 - OCR 辨識」（2026-08-05 修正版）的逐字移植。
 *
 *   - 「組裝請求」Code 節點 → parseImageInput() ＋ buildOcrRequestBody()
 *   - 「OpenAI Vision」HTTP 節點（timeout 30 秒、失敗重試一次、間隔 1 秒）→ callOpenAiWithRetry()
 *   - 「解析結果」Code 節點 → parseOcrContent()
 *
 * ⚠️ prompt、請求參數（model 由環境變數 OPENAI_MODEL 指定，預設與 n8n 相同）與解析規則都必須與 n8n 版完全一致，
 *    不要「優化」。tests/fixtures/n8n-golden.json 是直接執行 n8n 現行版 Code 節點得到的標準答案
 *    （產生方式見 tests/fixtures/generate-n8n-golden.mjs），tests/ocr.test.ts 會逐案例比對；
 *    改這個檔案前請先確認自己真的要改變辨識行為。
 */

// 系統提示詞：自 n8n「組裝請求」節點原封不動搬來（含全形空白與換行跳脫）。
export const OCR_SYSTEM_PROMPT = '你是專業的商品條碼標籤 OCR 辨識系統。請辨識商品條碼標籤上印刷的文字資訊。\n\n標籤有多種格式，以下是常見範例：\n\n【格式A】分行排列：\n條碼編號（純數字）\n商品品名\n性別　顏色+尺寸\n[一維條碼圖形]\n範例：「1801080204 / 第五代溫灸刷毛圓領發熱衣 / 女　經典黑L」\n\n【格式B】品名後括號內含所有屬性：\n條碼編號\n商品品名(顏色 性別 尺寸)\n[一維條碼圖形]\n範例：「1801472364 / 搖粒絨極暖衝鋒褲(星夜黑 男女共版 L)」\n\n【格式C】括號內用連字號分隔：\n[一維條碼圖形]\n條碼編號\n商品品名(性別-顏色 尺寸)\n範例：「1801872396 / 熱導石墨烯輕羽絨衣(中性-晨霧灰 2XL)」\n\n【格式D】括號內顏色+性別尺寸連寫：\n商品品名(顏色 性別+尺寸)\n[一維條碼圖形]\n條碼編號\n範例：「素面防曬排汗短版涼感衣(戀愛粉 女XL) / 1037720345」\n\n請辨識並回傳以下欄位（純 JSON，不含 markdown 標記）：\n{"barcode":"條碼數字編號","productName":"商品名稱（不含括號內容）","gender":"男 或 女 或 中性","color":"顏色名稱","size":"尺寸代碼"}\n\n重要規則：\n- productName 只取括號前的商品名稱，不含括號及括號內的屬性文字\n- 「男女共版」視為「中性」\n- 性別可能是：男、女、中性、男女共版\n- 尺寸為英文字母或數字（S、M、L、XL、XXL、2XL、3XL、F 等）\n- 顏色是中文描述（如「星夜黑」「晨霧灰」「戀愛粉」「經典黑」「深藍」等）\n- 括號內的分隔方式不固定：可能是空格、連字號、或直接連寫\n- 如果某欄位看不清楚或不存在，回傳空字串';

export const OCR_USER_TEXT = "請辨識這張商品條碼標籤上的所有文字資訊。";

/** n8n「OpenAI Vision」節點：options.timeout = 30000。 */
export const OPENAI_TIMEOUT_MS = 30_000;
/** n8n「OpenAI Vision」節點：retryOnFail、maxTries = 2（＝失敗後重試一次）、waitBetweenTries = 1000。 */
export const OPENAI_MAX_TRIES = 2;
export const OPENAI_RETRY_DELAY_MS = 1000;

export interface ParsedImage {
  mimeType: string;
  base64: string;
}

/**
 * 對應 n8n「組裝請求」前半段：前端送 data URL（`data:image/jpeg;base64,...`）；
 * 若不是 `data:` 開頭就視為純 base64、mime 一律當 image/jpeg。
 * 缺少或格式錯誤時丟 400（n8n 版是丟 Error，webhook 回 500；這裡改回 4xx 讓前端分辨）。
 */
export function parseImageInput(image: unknown): ParsedImage {
  if (typeof image !== "string" || image === "") {
    throw new ServiceError(400, "缺少 image 欄位");
  }
  if (image.startsWith("data:")) {
    // 含行終止符（\n、\r、U+2028、U+2029）的字串，下面的正規式必定不符合（`.` 不吃行終止符、`$` 沒有 m 旗標），
    // 結果與 n8n 版相同（無效的 data URL）；但引擎在判定失敗前會做二次方時間的回溯——
    // 一個 128 KB 的請求就能卡住這個單執行緒服務約 1 秒、1 MB 約 50 秒（ReDoS）。所以先擋掉。
    // 不含行終止符的輸入，這個正規式是線性時間。
    if (/[\n\r\u2028\u2029]/.test(image)) throw new ServiceError(400, "無效的 data URL");
    const match = image.match(/^data:(.+?);base64,(.+)$/);
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new ServiceError(400, "無效的 data URL");
    }
    return { mimeType: match[1], base64: match[2] };
  }
  return { mimeType: "image/jpeg", base64: image };
}

/** 對應 n8n「組裝請求」後半段：OpenAI chat/completions 的 request body（key 順序與 n8n 版相同）。 */
export function buildOcrRequestBody(image: ParsedImage, model: string) {
  return {
    model,
    max_completion_tokens: 300,
    reasoning_effort: "none" as const,
    temperature: 0.1,
    messages: [
      { role: "system" as const, content: OCR_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: OCR_USER_TEXT },
          {
            type: "image_url" as const,
            image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "auto" as const },
          },
        ],
      },
    ],
  };
}

export interface OcrFields {
  barcode: string;
  productName: string;
  gender: string;
  color: string;
  size: string;
}

/** n8n 的回應模板用 "{{ $json.xxx }}" 把欄位塞進 JSON 字串，所以前端永遠收到字串；這裡明確轉成字串。 */
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * 對應 n8n「解析結果」節點：
 *   1. trim；以 ```json 或 ``` 開頭就剝掉圍欄（開頭 ```json?\n? 與結尾 \n?```）。
 *   2. 直接 JSON.parse；失敗就抓第一個 `{` 到最後一個 `}` 之間的內容再 parse；都不行就算解析失敗。
 *   3. 性別「男女共版」→「中性」；缺欄位回空字串。
 * 解析失敗丟 502（上游給了無法使用的內容）。
 */
export function parseOcrContent(content: string): OcrFields {
  let data: Record<string, unknown>;
  try {
    let clean = content.trim();
    if (clean.startsWith("```json")) clean = clean.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    else if (clean.startsWith("```")) clean = clean.replace(/^```\n?/, "").replace(/\n?```$/, "");
    try {
      data = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("OCR parse fail");
      data = JSON.parse(m[0]) as Record<string, unknown>;
    }
    // n8n 版對 null 會在讀取 data.gender 時丟 TypeError → 失敗；其餘非物件值（字串、數字、陣列）得到全空欄位。
    if (data === null || data === undefined) throw new Error("OCR parse fail");
  } catch {
    throw new ServiceError(502, "OCR 回應無法解析，請重新拍照");
  }
  const gender = data.gender === "男女共版" ? "中性" : data.gender || "";
  return {
    barcode: toText(data.barcode || ""),
    productName: toText(data.productName || ""),
    gender: toText(gender),
    color: toText(data.color || ""),
    size: toText(data.size || ""),
  };
}

export interface OpenAiCallDeps {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  apiKey: string;
  /** 不含 /v1、不含尾端斜線，例如 https://api.openai.com。 */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/** 只取 OpenAI 錯誤回應的 type／code 寫進 log（不含 message，避免把被遮罩的金鑰片段寫進去）。 */
async function briefOpenAiError(res: Response): Promise<string> {
  const body = (await readJsonSafely(res)) as { error?: { type?: unknown; code?: unknown } } | null;
  const type = typeof body?.error?.type === "string" ? body.error.type : "";
  const code = typeof body?.error?.code === "string" ? body.error.code : "";
  return [type, code].filter(Boolean).join("/");
}

/**
 * 對應 n8n「OpenAI Vision」節點：POST {baseUrl}/v1/chat/completions，Bearer 金鑰，
 * 每次最多等 30 秒；任何失敗（非 2xx、連線錯誤、逾時）都等 1 秒後重試一次，兩次都失敗丟 502。
 * 成功回傳 OpenAI 回應的 JSON 物件。
 */
async function callOpenAiWithRetry(deps: OpenAiCallDeps, requestBody: string): Promise<unknown> {
  const url = `${deps.baseUrl}/v1/chat/completions`;
  const timeoutMs = deps.timeoutMs ?? OPENAI_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? OPENAI_RETRY_DELAY_MS;
  let failure = "";

  for (let attempt = 1; attempt <= OPENAI_MAX_TRIES; attempt++) {
    try {
      const res = await deps.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const json = await readJsonSafely(res);
        if (json === null) {
          deps.log.error("[ocr] OpenAI 回應不是合法 JSON");
          throw new ServiceError(502, "OCR 回應無法解析，請重新拍照");
        }
        return json;
      }
      const brief = await briefOpenAiError(res);
      failure = `HTTP ${res.status}${brief ? ` ${brief}` : ""}`;
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      failure = describeError(err);
    }
    deps.log.warn(`[ocr] OpenAI 呼叫失敗（第 ${attempt}/${OPENAI_MAX_TRIES} 次）：${failure}`);
    if (attempt < OPENAI_MAX_TRIES) await deps.sleep(retryDelayMs);
  }
  throw new ServiceError(502, "OCR 服務暫時無法使用，請稍後再試");
}

function extractContent(openAiJson: unknown): string {
  const choices = (openAiJson as { choices?: unknown } | null)?.choices;
  const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
  const content = first?.message?.content;
  if (typeof content !== "string") {
    throw new ServiceError(502, "OCR 回應格式不正確，請重新拍照");
  }
  return content;
}

/** 完整流程：組請求 → 呼叫 OpenAI（含重試）→ 解析。 */
export async function recognizeLabel(deps: OpenAiCallDeps, image: ParsedImage): Promise<OcrFields> {
  const requestBody = JSON.stringify(buildOcrRequestBody(image, deps.model));
  const openAiJson = await callOpenAiWithRetry(deps, requestBody);
  return parseOcrContent(extractContent(openAiJson));
}
