import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env.js";

describe("loadEnv", () => {
  it("沒有任何環境變數時使用預設值（金鑰類為空字串＝未設定）", () => {
    expect(loadEnv({})).toEqual({
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "https://api.openai.com",
      OPENAI_MODEL: "gpt-5.6-luna",
      GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "",
      GOOGLE_SHEET_ID: "1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A",
      GOOGLE_SHEET_NAME: "商品主檔",
      PORT: 8080,
    });
  });

  it("讀取並 trim 環境變數；OPENAI_BASE_URL 去掉尾端斜線", () => {
    const env = loadEnv({
      OPENAI_API_KEY: "  test-key \n",
      OPENAI_BASE_URL: "https://ai-hub.example.test///",
      OPENAI_MODEL: " other-model ",
      GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: " abc ",
      GOOGLE_SHEET_ID: "sheet-id",
      GOOGLE_SHEET_NAME: "分頁",
      PORT: "9090",
    });
    expect(env).toEqual({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://ai-hub.example.test",
      OPENAI_MODEL: "other-model",
      GOOGLE_SERVICE_ACCOUNT_CREDENTIALS: "abc",
      GOOGLE_SHEET_ID: "sheet-id",
      GOOGLE_SHEET_NAME: "分頁",
      PORT: 9090,
    });
  });

  it("空白字串視同未設定，回到預設值", () => {
    const env = loadEnv({ OPENAI_MODEL: "  ", GOOGLE_SHEET_NAME: "", OPENAI_BASE_URL: " ", GOOGLE_SHEET_ID: "\n" });
    expect(env.OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(env.GOOGLE_SHEET_NAME).toBe("商品主檔");
    expect(env.OPENAI_BASE_URL).toBe("https://api.openai.com");
    expect(env.GOOGLE_SHEET_ID).toBe("1Wql_6lg_PQ1TT2xOF_5tv2AwA8Wy-PUWfeRPaVV-B_A");
  });

  it("PORT 不合法時回到 8080（Zeabur 固定注入 PORT=8080）", () => {
    for (const bad of ["abc", "0", "-1", "70000", "80.5", ""]) {
      expect(loadEnv({ PORT: bad }).PORT).toBe(8080);
    }
    expect(loadEnv({ PORT: "8099" }).PORT).toBe(8099);
  });
});
