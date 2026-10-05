import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../src/common.js";
import {
  buildOcrRequestBody,
  OCR_SYSTEM_PROMPT,
  OCR_USER_TEXT,
  parseImageInput,
  parseOcrContent,
  recognizeLabel,
  type OpenAiCallDeps,
} from "../src/ocr.js";
import { createCapturingLogger, createFetchMock, jsonResponse, SAMPLE_IMAGE } from "./helpers.js";

// 標準答案：直接執行 n8n 現行版 Code 節點得到的結果（見 tests/fixtures/n8n-golden.json 的 _source）。
interface Golden {
  model: string;
  requestCases: Array<{ name: string; input: { image: string }; requestBody: string }>;
  requestErrorCases: Array<{ name: string; input: { image?: string }; n8nError: string }>;
  parseCases: Array<{
    name: string;
    content: string;
    expected?: Record<string, string>;
    n8nFailed?: boolean;
  }>;
}
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/n8n-golden.json", import.meta.url), "utf8"),
) as Golden;

describe("OCR 請求 body 與 n8n 版逐字相同（prompt、model、參數）", () => {
  it.each(golden.requestCases)("n8n 實際送出的 body 與本服務逐字相同：$name", ({ input, requestBody }) => {
    const body = JSON.stringify(buildOcrRequestBody(parseImageInput(input.image), golden.model));
    expect(body).toBe(requestBody);
  });

  it("system prompt 原封不動（與 n8n 實際送出的 prompt 相同）", () => {
    const n8nBody = JSON.parse(golden.requestCases[0]!.requestBody) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(OCR_SYSTEM_PROMPT).toBe(n8nBody.messages[0]!.content);
    // 抽樣確認關鍵內容（含全形空白 U+3000 與「男女共版」規則）
    expect(OCR_SYSTEM_PROMPT).toContain("性別　顏色+尺寸");
    expect(OCR_SYSTEM_PROMPT).toContain("「男女共版」視為「中性」");
    expect(OCR_SYSTEM_PROMPT.length).toBe(750);
  });

  it("model、max_completion_tokens、reasoning_effort、temperature、訊息結構", () => {
    const body = buildOcrRequestBody({ mimeType: "image/png", base64: "QUJD" }, "gpt-5.6-luna");
    expect(Object.keys(body)).toEqual(["model", "max_completion_tokens", "reasoning_effort", "temperature", "messages"]);
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.max_completion_tokens).toBe(300);
    expect(body.reasoning_effort).toBe("none");
    expect(body.temperature).toBe(0.1);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.messages).toEqual([
      { role: "system", content: OCR_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "請辨識這張商品條碼標籤上的所有文字資訊。" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD", detail: "auto" } },
        ],
      },
    ]);
    expect(OCR_USER_TEXT).toBe("請辨識這張商品條碼標籤上的所有文字資訊。");
  });

  it("model 可由呼叫端指定（OPENAI_MODEL）", () => {
    expect(buildOcrRequestBody({ mimeType: "image/jpeg", base64: "QQ==" }, "another-model").model).toBe("another-model");
  });
});

describe("parseImageInput（對應 n8n「組裝請求」前半段）", () => {
  it("data URL → 拆出 mime 與 base64", () => {
    expect(parseImageInput("data:image/jpeg;base64,QUJD")).toEqual({ mimeType: "image/jpeg", base64: "QUJD" });
  });

  it("沒有 data: 前綴 → 視為純 base64、mime 當 image/jpeg", () => {
    expect(parseImageInput("QUJD")).toEqual({ mimeType: "image/jpeg", base64: "QUJD" });
  });

  it.each(golden.requestErrorCases)("與 n8n 相同的錯誤訊息（改回 400）：$name", ({ input, n8nError }) => {
    const error = (() => {
      try {
        parseImageInput(input.image);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(400);
    expect((error as ServiceError).message).toBe(n8nError);
  });

  it("image 不是字串 → 400 缺少 image 欄位", () => {
    for (const bad of [undefined, null, 123, {}, []]) {
      expect(() => parseImageInput(bad)).toThrowError(expect.objectContaining({ status: 400, message: "缺少 image 欄位" }));
    }
  });

  it("含行終止符的 data URL 一律是「無效的 data URL」（與 n8n 相同），包含 \\r、U+2028、U+2029", () => {
    for (const bad of ["data:image/jpeg;base64,AA\nBB", "data:image/jpeg;base64,AA\rBB", "data:image/jpeg;base64,AA\u2028BB", "data:image/jpeg;base64,AA\u2029BB", "data:image/jpeg;base64,AA\n"]) {
      expect(() => parseImageInput(bad)).toThrowError(expect.objectContaining({ status: 400, message: "無效的 data URL" }));
    }
  });

  // 回歸測試：原本的正規式 /^data:(.+?);base64,(.+)$/ 遇到這種輸入是二次方時間（128 KB 約 0.8 秒、1 MB 約 50 秒），
  // 單一請求就能卡住整個單執行緒服務。修正後（先擋行終止符）應在毫秒內回應。
  it("ReDoS 回歸：含換行的超長 data URL 立即拒絕（不做二次方回溯）", () => {
    const attack = "data:" + ";base64,".repeat(30_000) + "\nx"; // 約 240 KB；修正前要 2～3 秒
    const started = performance.now();
    expect(() => parseImageInput(attack)).toThrowError(expect.objectContaining({ status: 400, message: "無效的 data URL" }));
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("不含行終止符的超長 data URL 仍是線性時間，且能正確解析", () => {
    const big = "A".repeat(5_000_000);
    const started = performance.now();
    expect(parseImageInput(`data:image/jpeg;base64,${big}`)).toEqual({ mimeType: "image/jpeg", base64: big });
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("parseOcrContent（對應 n8n「解析結果」）", () => {
  const sample = '{"barcode":"1801080204","productName":"第五代溫灸刷毛圓領發熱衣","gender":"女","color":"經典黑","size":"L"}';

  it("純 JSON", () => {
    expect(parseOcrContent(sample)).toEqual({
      barcode: "1801080204",
      productName: "第五代溫灸刷毛圓領發熱衣",
      gender: "女",
      color: "經典黑",
      size: "L",
    });
  });

  it("```json 圍欄", () => {
    expect(parseOcrContent("```json\n" + sample + "\n```").barcode).toBe("1801080204");
  });

  it("夾雜說明文字：抓第一個 { 到最後一個 }", () => {
    const result = parseOcrContent("辨識結果如下：\n" + sample + "\n以上，請確認。");
    expect(result.productName).toBe("第五代溫灸刷毛圓領發熱衣");
    expect(result.size).toBe("L");
  });

  it("男女共版 → 中性", () => {
    const result = parseOcrContent('{"barcode":"1","productName":"A","gender":"男女共版","color":"藍","size":"M"}');
    expect(result.gender).toBe("中性");
  });

  it("缺欄位回空字串", () => {
    expect(parseOcrContent('{"barcode":"123"}')).toEqual({
      barcode: "123",
      productName: "",
      gender: "",
      color: "",
      size: "",
    });
  });

  it("完全無法解析 → 502", () => {
    for (const bad of ["", "   ", "無法辨識", "{barcode: 123}", "null"]) {
      expect(() => parseOcrContent(bad)).toThrowError(expect.objectContaining({ status: 502 }));
    }
  });

  // 與 n8n 現行版逐案例比對（含 n8n 版會失敗的案例）。
  it.each(golden.parseCases)("與 n8n 輸出一致：$name", (testCase) => {
    if (testCase.n8nFailed) {
      expect(() => parseOcrContent(testCase.content)).toThrowError(expect.objectContaining({ status: 502 }));
    } else {
      expect(parseOcrContent(testCase.content)).toEqual(testCase.expected);
    }
  });
});

describe("recognizeLabel（呼叫 OpenAI：timeout、重試一次、錯誤處理）", () => {
  const openAiOk = (content: string) => jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
  const labelJson = '{"barcode":"1801080204","productName":"第五代溫灸刷毛圓領發熱衣","gender":"女","color":"經典黑","size":"L"}';

  function setup(handler: Parameters<typeof createFetchMock>[0], overrides: Partial<OpenAiCallDeps> = {}) {
    const { mock, calls } = createFetchMock(handler);
    const sleep = vi.fn(async () => undefined);
    const log = createCapturingLogger();
    const deps: OpenAiCallDeps = {
      fetchImpl: mock,
      sleep,
      log,
      apiKey: "test-openai-key-123",
      baseUrl: "https://api.openai.com",
      model: "gpt-5.6-luna",
      ...overrides,
    };
    return { deps, calls, sleep, log };
  }

  it("成功：POST {baseUrl}/v1/chat/completions，Bearer 金鑰，body 與 n8n 版相同，30 秒 timeout", async () => {
    const { deps, calls, sleep } = setup(() => openAiOk(labelJson));
    const result = await recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE));

    expect(result).toEqual({ barcode: "1801080204", productName: "第五代溫灸刷毛圓領發熱衣", gender: "女", color: "經典黑", size: "L" });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();

    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer test-openai-key-123");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toBe(JSON.stringify(buildOcrRequestBody(parseImageInput(SAMPLE_IMAGE), "gpt-5.6-luna")));
  });

  it("每次呼叫 OpenAI 的 timeout 是 30 秒（重試時各自重新計時）", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const { deps } = setup(() => jsonResponse({}, 500));
      await recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE)).catch(() => undefined);
      expect(timeoutSpy.mock.calls).toEqual([[30_000], [30_000]]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("OPENAI_BASE_URL 可換成其他 OpenAI 相容端點", async () => {
    const { deps, calls } = setup(() => openAiOk(labelJson), { baseUrl: "https://ai-hub.example.test" });
    await recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE));
    expect(calls[0]!.url).toBe("https://ai-hub.example.test/v1/chat/completions");
  });

  it("上游 5xx：等 1 秒後重試一次，第二次成功就回結果", async () => {
    let n = 0;
    const { deps, calls, sleep } = setup(() => (++n === 1 ? jsonResponse({ error: { type: "server_error" } }, 503) : openAiOk(labelJson)));
    const result = await recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE));
    expect(result.barcode).toBe("1801080204");
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("上游 5xx 連續兩次：不再重試，丟 502（共呼叫兩次）", async () => {
    const { deps, calls, sleep } = setup(() => jsonResponse({ error: { type: "server_error", code: "overloaded" } }, 500));
    const error = await recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(502);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("連線錯誤也會重試一次（與 n8n 的 retryOnFail 相同：任何失敗都重試）", async () => {
    let n = 0;
    const { deps, calls } = setup(() => {
      if (++n === 1) throw new TypeError("fetch failed");
      return openAiOk(labelJson);
    });
    await recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE));
    expect(calls).toHaveLength(2);
  });

  it("4xx 也會重試一次（n8n 的 HTTP 節點對任何非 2xx 都算失敗）", async () => {
    const { deps, calls } = setup(() => jsonResponse({ error: { type: "invalid_request_error" } }, 400));
    await expect(recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE))).rejects.toMatchObject({ status: 502 });
    expect(calls).toHaveLength(2);
  });

  it("上游回 200 但內容無法解析：直接 502、不重試（n8n 的重試只在 HTTP 節點）", async () => {
    const { deps, calls } = setup(() => openAiOk("我看不太清楚這張圖"));
    await expect(recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE))).rejects.toMatchObject({ status: 502 });
    expect(calls).toHaveLength(1);
  });

  it("上游回 200 但不是 JSON、或沒有 choices：502", async () => {
    const notJson = setup(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(recognizeLabel(notJson.deps, parseImageInput(SAMPLE_IMAGE))).rejects.toMatchObject({ status: 502 });
    expect(notJson.calls).toHaveLength(1);

    const noChoices = setup(() => jsonResponse({ choices: [] }));
    await expect(recognizeLabel(noChoices.deps, parseImageInput(SAMPLE_IMAGE))).rejects.toMatchObject({ status: 502 });
  });

  it("錯誤訊息與 log 都不含 API 金鑰、圖片內容、上游錯誤全文", async () => {
    const { deps, log } = setup(() =>
      jsonResponse({ error: { message: "Incorrect API key provided: test-openai-key-123", type: "invalid_request_error", code: "invalid_api_key" } }, 401),
    );
    const error = (await recognizeLabel(deps, parseImageInput(SAMPLE_IMAGE)).catch((e: unknown) => e)) as ServiceError;
    const everything = `${error.message}\n${log.lines.join("\n")}`;
    expect(everything).not.toContain("test-openai-key-123");
    expect(everything).not.toContain("/9j/4AAQ");
    expect(everything).not.toContain("Incorrect API key");
    expect(log.lines.join("\n")).toContain("invalid_request_error/invalid_api_key"); // 只留 type/code，方便除錯
  });
});
