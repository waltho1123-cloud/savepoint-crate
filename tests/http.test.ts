import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { clientIpOf, isHttpsRequest, isInsecurePublicRequest, publicOrigin, readJsonObject } from "../src/http.js";

function makeApp() {
  const app = new Hono();
  app.get("/https", (c) => c.json({ https: isHttpsRequest(c) }));
  app.get("/origin", (c) => c.json({ origin: publicOrigin(c) }));
  app.get("/insecure", (c) => c.json({ insecure: isInsecurePublicRequest(c) }));
  app.get("/ip", (c) => c.json({ ip: clientIpOf(c) }));
  app.post("/json", async (c) => c.json(await readJsonObject(c)));
  app.onError((err, c) => c.json({ error: (err as { message: string }).message, status: (err as { status?: number }).status ?? 500 }, 400));
  return app;
}

const get = async (path: string, headers: Record<string, string> = {}) => (await makeApp().request(path, { headers })).json() as Promise<Record<string, unknown>>;

describe("isHttpsRequest", () => {
  it("X-Forwarded-Proto 優先：https 為真、http 為假；多值（代理串）取第一個；大小寫不拘", async () => {
    expect((await get("/https", { "x-forwarded-proto": "https" })).https).toBe(true);
    expect((await get("/https", { "x-forwarded-proto": "HTTPS" })).https).toBe(true);
    expect((await get("/https", { "x-forwarded-proto": "https, http" })).https).toBe(true);
    expect((await get("/https", { "x-forwarded-proto": " https ,http" })).https).toBe(true);
    expect((await get("/https", { "x-forwarded-proto": "http" })).https).toBe(false);
    expect((await get("/https", { "x-forwarded-proto": "http, https" })).https).toBe(false);
    expect((await get("/https", { "x-forwarded-proto": "ftp" })).https).toBe(false);
  });

  it("標頭優先於連線本身：連線是 https 但代理說 http，以代理為準", async () => {
    const res = await makeApp().request("https://example.test/https", { headers: { "x-forwarded-proto": "http" } });
    expect(((await res.json()) as { https: boolean }).https).toBe(false);
  });

  it("沒有標頭：看請求網址本身的協定", async () => {
    const secure = await makeApp().request("https://example.test/https");
    expect(((await secure.json()) as { https: boolean }).https).toBe(true);
    const plain = await makeApp().request("http://example.test/https");
    expect(((await plain.json()) as { https: boolean }).https).toBe(false);
  });
});

describe("publicOrigin", () => {
  it("公開網域：預設 https；X-Forwarded-Proto 明說 http／https 就照它", async () => {
    expect((await get("/origin", { host: "savepoint-crate.zeabur.app" })).origin).toBe("https://savepoint-crate.zeabur.app");
    expect((await get("/origin", { host: "savepoint-crate.zeabur.app", "x-forwarded-proto": "http" })).origin).toBe("http://savepoint-crate.zeabur.app");
    expect((await get("/origin", { host: "x.example.com:8443", "x-forwarded-proto": "https" })).origin).toBe("https://x.example.com:8443");
  });

  it.each(["localhost", "localhost:8080", "LOCALHOST:3000", "127.0.0.1:8080", "127.1.2.3", "10.0.0.5:8080", "192.168.1.20", "172.16.0.1", "172.31.255.255:80", "[::1]:8080"])(
    "本機與內網位址 %s 沒有 X-Forwarded-Proto 時視為 http",
    async (host) => {
      expect((await get("/origin", { host })).origin).toBe(`http://${host}`);
    },
  );

  it.each(["172.15.0.1", "172.32.0.1", "8.8.8.8", "11.0.0.1", "192.169.1.1"])("非內網的位址 %s 視為 https", async (host) => {
    expect((await get("/origin", { host })).origin).toBe(`https://${host}`);
  });

  it("X-Forwarded-Host 優先於 Host；多值取第一個", async () => {
    expect((await get("/origin", { host: "internal:8080", "x-forwarded-host": "public.example.com" })).origin).toBe("https://public.example.com");
    expect((await get("/origin", { host: "internal:8080", "x-forwarded-host": "a.example.com, b.example.com" })).origin).toBe("https://a.example.com");
  });

  it("X-Forwarded-Proto 不是 http／https 的值被忽略，改用位址判斷", async () => {
    expect((await get("/origin", { host: "example.com", "x-forwarded-proto": "javascript" })).origin).toBe("https://example.com");
    expect((await get("/origin", { host: "localhost:8080", "x-forwarded-proto": "ws" })).origin).toBe("http://localhost:8080");
  });

  it("缺少 Host 標頭：回佔位字串", async () => {
    expect((await get("/origin")).origin).toBe("https://<網域>");
  });

  it.each([
    ["空字串", ""],
    ["含空白", "a b.com"],
    ["含斜線", "a.com/evil"],
    ["含 @", "user@evil.com"],
    ["含引號與角括號", 'evil"><script>alert(1)</script>'],
    ["埠號超過 5 位", "example.com:123456"],
    ["埠號是空的", "example.com:"],
    ["底線", "exam_ple.com"],
    ["以點開頭", ".example.com"],
    ["全是特殊字元", "!!!"],
  ])("不合法的主機名稱（%s）：回佔位字串，不顯示它", async (_name, host) => {
    expect((await get("/origin", { "x-forwarded-host": host })).origin).toBe("https://<網域>");
  });
});

describe("isInsecurePublicRequest（公開網域上的明文 http）", () => {
  const insecure = async (headers: Record<string, string>) => (await get("/insecure", headers)).insecure;

  it("公開網域＋非 https：true（沒有 X-Forwarded-Proto 或明說 http 都是）", async () => {
    expect(await insecure({ host: "savepoint-crate.zeabur.app" })).toBe(true);
    expect(await insecure({ host: "savepoint-crate.zeabur.app", "x-forwarded-proto": "http" })).toBe(true);
    expect(await insecure({ host: "8.8.8.8:8080" })).toBe(true);
  });

  it("https（代理告知）一律不是", async () => {
    expect(await insecure({ host: "savepoint-crate.zeabur.app", "x-forwarded-proto": "https" })).toBe(false);
  });

  it.each(["localhost", "localhost:8080", "127.0.0.1:8080", "10.1.2.3", "192.168.0.5:3000", "172.20.1.1", "[::1]:8080"])("本機與內網（%s）不算", async (host) => {
    expect(await insecure({ host })).toBe(false);
  });

  it("看不出主機（沒有 Host、格式不合法）：false，不亂警告", async () => {
    expect(await insecure({})).toBe(false);
    expect(await insecure({ "x-forwarded-host": "bad host!" })).toBe(false);
  });

  it("X-Forwarded-Host 優先於 Host", async () => {
    expect(await insecure({ host: "localhost:8080", "x-forwarded-host": "public.example.com" })).toBe(true);
    expect(await insecure({ host: "public.example.com", "x-forwarded-host": "localhost:8080" })).toBe(false);
  });
});

describe("clientIpOf", () => {
  it("沒有真實連線（app.request）也沒有標頭：unknown；有 X-Forwarded-For 時取由右往左第一個公開位址", async () => {
    expect((await get("/ip")).ip).toBe("unknown");
    expect((await get("/ip", { "x-forwarded-for": "198.51.100.1, 203.0.113.9, 10.0.0.7" })).ip).toBe("203.0.113.9");
  });
});

describe("readJsonObject", () => {
  const post = (body: string) => makeApp().request("/json", { method: "POST", headers: { "content-type": "application/json" }, body });

  it("JSON 物件原樣回傳", async () => {
    expect(await (await post('{"a":1,"b":"二"}')).json()).toEqual({ a: 1, b: "二" });
  });

  it.each([
    ["不是 JSON", "{oops"],
    ["空內容", ""],
    ["陣列", "[1]"],
    ["字串", '"x"'],
    ["數字", "5"],
    ["null", "null"],
  ])("%s → ServiceError 400", async (_name, body) => {
    const res = await post(body);
    const json = (await res.json()) as { status: number };
    expect(json.status).toBe(400);
  });
});
