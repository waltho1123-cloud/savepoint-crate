import { createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../src/common.js";
import {
  buildServiceAccountJwt,
  GOOGLE_TOKEN_URL,
  GoogleTokenProvider,
  parseServiceAccountCredentials,
  SHEETS_SCOPE,
  TOKEN_CACHE_MS,
} from "../src/google-auth.js";
import { createCapturingLogger, createFetchMock, jsonResponse, makeCredentials } from "./helpers.js";

const creds = makeCredentials();

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("parseServiceAccountCredentials：憑證兩種格式（原始 JSON／base64）", () => {
  it("原始 JSON 字串", () => {
    const parsed = parseServiceAccountCredentials(creds.json);
    expect(parsed).toEqual({ client_email: creds.email, private_key: creds.privateKeyPem });
  });

  it("base64 編碼的 JSON（Zeabur 上實際存放的格式）", () => {
    const parsed = parseServiceAccountCredentials(creds.base64);
    expect(parsed).toEqual({ client_email: creds.email, private_key: creds.privateKeyPem });
  });

  it("前後有空白或換行的 base64 也能解析（貼進環境變數常見）", () => {
    expect(parseServiceAccountCredentials(`\n  ${creds.base64}  \n`)?.client_email).toBe(creds.email);
  });

  it("每 76 字元折行的 base64（Linux 的 base64 指令預設輸出）也能解析", () => {
    const wrapped = creds.base64.replace(/(.{76})/g, "$1\n");
    expect(wrapped).toContain("\n");
    expect(parseServiceAccountCredentials(wrapped)?.client_email).toBe(creds.email);
  });

  it("base64url（-、_ 且無補齊等號）也能解析", () => {
    // 加一個欄位讓編碼結果必定出現 + 與 /（對應 base64url 的 - 與 _）
    const json = JSON.stringify({ ...JSON.parse(creds.json), note: ">>>???~~~" });
    const url = Buffer.from(json, "utf8").toString("base64url");
    expect(url).toMatch(/[-_]/);
    expect(parseServiceAccountCredentials(url)?.client_email).toBe(creds.email);
  });

  it("私鑰裡的換行被再跳脫成字面的 \\n 時，還原成真正的換行", () => {
    const doubleEscaped = JSON.stringify({
      client_email: creds.email,
      private_key: creds.privateKeyPem.replace(/\n/g, "\\n"),
    });
    const parsed = parseServiceAccountCredentials(doubleEscaped);
    expect(parsed?.private_key).toBe(creds.privateKeyPem);
    // 還原後必須真的能拿來簽章
    expect(() => buildServiceAccountJwt(parsed!, SHEETS_SCOPE)).not.toThrow();
  });

  it.each([
    ["假金鑰 x", "x"],
    ["空字串", ""],
    ["純空白", "   \n "],
    ["不是 JSON 也不是 base64 的壞字串", "這不是憑證 {{{"],
    ["JSON 但缺 private_key", JSON.stringify({ client_email: "a@b.c" })],
    ["JSON 但缺 client_email", JSON.stringify({ private_key: "k" })],
    ["欄位是空字串", JSON.stringify({ client_email: "", private_key: "" })],
    ["欄位型別不對", JSON.stringify({ client_email: 1, private_key: 2 })],
    ["JSON 陣列", "[]"],
    ["JSON null", "null"],
    ["base64 但解出來不是 JSON", Buffer.from("hello world").toString("base64")],
    ["base64 的 JSON 陣列", Buffer.from("[1,2,3]").toString("base64")],
  ])("壞字串回 null、不丟例外：%s", (_name, raw) => {
    expect(parseServiceAccountCredentials(raw)).toBeNull();
  });

  it("undefined／null 回 null", () => {
    expect(parseServiceAccountCredentials(undefined)).toBeNull();
    expect(parseServiceAccountCredentials(null)).toBeNull();
  });
});

describe("buildServiceAccountJwt", () => {
  it("RS256 簽章、claims 正確，且簽章可用對應公鑰驗證", () => {
    const parsed = parseServiceAccountCredentials(creds.base64)!;
    const nowSeconds = 1_800_000_000;
    const jwt = buildServiceAccountJwt(parsed, SHEETS_SCOPE, nowSeconds);

    const [header, claims, signature, ...rest] = jwt.split(".");
    expect(rest).toHaveLength(0);
    expect(decodeSegment(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims!)).toEqual({
      iss: creds.email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: GOOGLE_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(creds.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("JWT 字串不含私鑰內容", () => {
    const parsed = parseServiceAccountCredentials(creds.json)!;
    const jwt = buildServiceAccountJwt(parsed, SHEETS_SCOPE);
    expect(jwt).not.toContain(creds.privateKeyPem);
    expect(jwt).not.toMatch(/PRIVATE/);
  });
});

describe("GoogleTokenProvider", () => {
  function setup(options: { status?: number; now?: () => number } = {}) {
    const log = createCapturingLogger();
    const { mock, calls } = createFetchMock(() =>
      options.status && options.status !== 200
        ? jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, options.status)
        : jsonResponse({ access_token: "test-google-access-token", expires_in: 3599, token_type: "Bearer" }),
    );
    const provider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.base64)!, {
      fetchImpl: mock,
      log,
      now: options.now,
    });
    return { provider, calls, log, mock };
  }

  it("以 JWT Bearer flow 向 Google 換 token（POST 表單、assertion 簽章可驗證）", async () => {
    const { provider, calls } = setup();
    expect(await provider.getToken()).toBe("test-google-access-token");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(GOOGLE_TOKEN_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.signal).toBeInstanceOf(AbortSignal);

    const form = new URLSearchParams(call.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(creds.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    expect(decodeSegment(claims!).iss).toBe(creds.email);
  });

  it("換 token 的 timeout 是 15 秒", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await setup().provider.getToken();
      expect(timeoutSpy.mock.calls).toEqual([[15_000]]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("token 快取 55 分鐘：期間內不重複換、過期後重新換", async () => {
    let clock = 1_000_000;
    const { provider, calls } = setup({ now: () => clock });
    await provider.getToken();
    clock += TOKEN_CACHE_MS - 1000; // 54 分 59 秒
    await provider.getToken();
    expect(calls).toHaveLength(1);

    clock += 2000; // 超過 55 分鐘
    await provider.getToken();
    expect(calls).toHaveLength(2);
    expect(TOKEN_CACHE_MS).toBe(55 * 60 * 1000);
  });

  it("invalidate() 之後下一次一定重新換 token", async () => {
    const { provider, calls } = setup();
    await provider.getToken();
    provider.invalidate();
    await provider.getToken();
    expect(calls).toHaveLength(2);
  });

  it("同時多個請求只會換一次 token", async () => {
    const { provider, calls } = setup();
    const tokens = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("Google 回 4xx：丟 500 的 ServiceError，訊息與 log 都不含私鑰", async () => {
    const { provider, log } = setup({ status: 400 });
    const error = await provider.getToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(500);
    expect((error as ServiceError).message).not.toContain(creds.privateKeyPem);
    expect(log.lines.join("\n")).toContain("HTTP 400");
    expect(log.lines.join("\n")).not.toContain(creds.privateKeyPem);
  });

  it("Google 回 5xx：丟 502", async () => {
    const { provider } = setup({ status: 503 });
    await expect(provider.getToken()).rejects.toMatchObject({ status: 502 });
  });

  it("連線失敗：丟 502", async () => {
    const provider = new GoogleTokenProvider(parseServiceAccountCredentials(creds.json)!, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      log: createCapturingLogger(),
    });
    await expect(provider.getToken()).rejects.toMatchObject({ status: 502 });
  });

  it("私鑰格式錯誤：丟 500，且不會呼叫 Google", async () => {
    const { mock, calls } = createFetchMock(() => jsonResponse({}));
    const provider = new GoogleTokenProvider(
      { client_email: creds.email, private_key: "不是 PEM" },
      { fetchImpl: mock, log: createCapturingLogger() },
    );
    await expect(provider.getToken()).rejects.toMatchObject({ status: 500, message: expect.stringContaining("私鑰") });
    expect(calls).toHaveLength(0);
  });
});
