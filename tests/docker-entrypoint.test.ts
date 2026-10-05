import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "./process-helpers.js";
import { cleanupTempDirs, makeTempDir } from "./settings-helpers.js";

afterEach(cleanupTempDirs);

// 入口腳本（scripts/docker-entrypoint.sh）的行為測試：不需要 docker，用假的 id／find／chown／su-exec 放在 PATH 最前面，
// 其餘（mkdir、printf、head、exec）用真的。真正的容器行為（su-exec、Volume 擁有者、PID 1）另外用 docker 驗證過。

const script = join(repoRoot, "scripts", "docker-entrypoint.sh");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

interface Fakes {
  bin: string;
  log: string;
}

async function makeFakes(): Promise<Fakes> {
  const root = await makeTempDir("entrypoint-fakes-");
  const bin = join(root, "bin");
  await mkdir(bin);
  const log = join(root, "calls.log");
  await writeFile(log, "");
  const write = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  // id -u：由 FAKE_UID 決定（su-exec 之後會變成 10001，模擬降權）
  await write("id", 'echo "${FAKE_UID:-0}"');
  // find：不真的掃目錄，由 FAKE_FIND_OUTPUT 決定「有沒有不屬於 appuser 的項目」
  // 記錄一律用 printf '%s\n'：有些 sh 的 echo 會解讀參數裡的反斜線跳脫（例如 macOS 的 /bin/sh），把一行拆成好幾行
  await write("find", 'printf \'%s\\n\' "find $*" >> "$FAKE_LOG"\n[ -n "${FAKE_FIND_OUTPUT:-}" ] && printf \'%s\\n\' "$FAKE_FIND_OUTPUT"\nexit 0');
  await write("chown", 'printf \'%s\\n\' "chown $*" >> "$FAKE_LOG"\n[ "${FAKE_CHOWN_FAIL:-0}" = "1" ] && exit 1\nexit 0');
  // su-exec：記錄參數，丟掉 user:group，把 FAKE_UID 換成 10001 後執行後面的指令（模擬降權）
  await write("su-exec", 'printf \'%s\\n\' "su-exec $*" >> "$FAKE_LOG"\nshift\nFAKE_UID=10001\nexport FAKE_UID\nexec "$@"');
  return { bin, log };
}

function run(fakes: Fakes, env: Record<string, string>, args: string[] = []) {
  const result = spawnSync(script, args, {
    env: { PATH: `${fakes.bin}:${process.env.PATH ?? ""}`, FAKE_LOG: fakes.log, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 最後被 exec 的指令：印出它看到的 FAKE_UID 與兩個參數（驗證參數沒有被拆開、環境有帶過去）。 */
const FINAL = ["sh", "-c", 'printf "final uid=%s a1=[%s] a2=[%s]\\n" "${FAKE_UID:-unset}" "$1" "$2"', "sh", "has space", "second"];

describe("scripts/docker-entrypoint.sh（以假的 id／find／chown／su-exec 驗證流程）", () => {
  it("檔案本身：有執行權限、shebang 是 /bin/sh、沒有 CRLF、語法檢查通過、用 set -eu、預設資料目錄 /app/data", async () => {
    const text = await readFile(script, "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect((await stat(script)).mode & 0o111).toBeGreaterThan(0);
    expect(text).toContain("set -eu");
    expect(text).toContain('DATA_DIR="${DATA_DIR:-/app/data}"');
    expect(spawnSync("sh", ["-n", script]).status).toBe(0);
  });

  it("變數一律用 ${DATA_DIR} 的寫法：後面接全形括號時，某些 sh（macOS 的 bash 3.2）會把它當成變數名稱的一部分而在 set -u 下爆掉", async () => {
    const text = await readFile(script, "utf8");
    expect(text).not.toMatch(/\$DATA_DIR/);
    expect(text).not.toMatch(/\$APP_(USER|GROUP)/);
  });

  it("root 啟動、資料目錄有不屬於 appuser 的項目：建目錄 → chown -R -h → su-exec appuser:appgroup 重新執行自己 → 降權後執行原本的指令，參數原樣保留", async () => {
    const fakes = await makeFakes();
    const dataDir = join(await makeTempDir(), "vol");
    const result = run(fakes, { FAKE_UID: "0", DATA_DIR: dataDir, FAKE_FIND_OUTPUT: "foreign-file" }, FINAL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("final uid=10001 a1=[has space] a2=[second]");
    expect(result.stdout).toContain(`修正 ${dataDir} 的擁有者為 appuser`);
    expect((await stat(dataDir)).isDirectory()).toBe(true); // mkdir -p 建出來了
    const calls = (await readFile(fakes.log, "utf8")).trim().split("\n");
    expect(calls).toContain(`find ${dataDir} ! -user appuser`);
    expect(calls).toContain(`chown -R -h appuser:appgroup ${dataDir}`); // -h：不追符號連結
    const suExec = calls.find((line) => line.startsWith("su-exec "))!;
    expect(suExec.startsWith(`su-exec appuser:appgroup ${script} `)).toBe(true);
    expect(suExec.endsWith("has space second")).toBe(true);
    // 順序：chown 在 su-exec 之前
    expect(calls.findIndex((l) => l.startsWith("chown"))).toBeLessThan(calls.findIndex((l) => l.startsWith("su-exec")));
    expect(result.stderr).toBe("");
  });

  it("root 啟動、所有項目都已經屬於 appuser：不 chown（每次啟動只是一次很快的掃描），照樣降權", async () => {
    const fakes = await makeFakes();
    const dataDir = join(await makeTempDir(), "vol");
    const result = run(fakes, { FAKE_UID: "0", DATA_DIR: dataDir, FAKE_FIND_OUTPUT: "" }, FINAL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("final uid=10001");
    const calls = (await readFile(fakes.log, "utf8")).trim().split("\n");
    expect(calls.some((l) => l.startsWith("chown"))).toBe(false);
    expect(calls.some((l) => l.startsWith("su-exec"))).toBe(true);
  });

  it("root 啟動、建不了資料目錄（上層是一般檔案）：只印警告，不退出——照樣降權並執行原本的指令（OCR、存檔不能被設定頁的 Volume 問題拖垮）", async () => {
    const fakes = await makeFakes();
    const root = await makeTempDir();
    const blocker = join(root, "file");
    await writeFile(blocker, "x");
    const result = run(fakes, { FAKE_UID: "0", DATA_DIR: join(blocker, "data") }, FINAL);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("警告");
    expect(result.stderr).toContain("無法建立 DATA_DIR");
    expect(result.stdout).toContain("final uid=10001");
    const calls = (await readFile(fakes.log, "utf8")).trim().split("\n");
    expect(calls.some((l) => l.startsWith("chown"))).toBe(false); // 目錄都沒有，不用 chown
    expect(calls.some((l) => l.startsWith("su-exec"))).toBe(true);
  });

  it("root 啟動、chown 失敗（例如平台不允許）：只印警告，不退出，照樣降權並執行原本的指令", async () => {
    const fakes = await makeFakes();
    const dataDir = join(await makeTempDir(), "vol");
    const result = run(fakes, { FAKE_UID: "0", DATA_DIR: dataDir, FAKE_FIND_OUTPUT: "foreign", FAKE_CHOWN_FAIL: "1" }, FINAL);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("警告");
    expect(result.stderr).toContain("無法修正 DATA_DIR");
    expect(result.stdout).toContain("final uid=10001");
  });

  it("DATA_DIR 沒設定：預設是 /app/data（root 階段會對它 mkdir／find）", async () => {
    const fakes = await makeFakes();
    const result = run(fakes, { FAKE_UID: "0", FAKE_FIND_OUTPUT: "" }, FINAL);
    // 開發機上不能建立 /app/data：會有警告，但流程照樣走完；重點是 find 掃的是預設路徑
    expect(result.status).toBe(0);
    const calls = (await readFile(fakes.log, "utf8")).trim().split("\n");
    const find = calls.find((l) => l.startsWith("find "));
    if (find) expect(find).toBe("find /app/data ! -user appuser"); // /app/data 建得起來的機器（容器裡）才會走到
    else expect(result.stderr).toContain("/app/data");
  });

  it("非 root 啟動（平台用 --user／runAsNonRoot）、目錄可寫：不 chown、不 su-exec，直接執行原本的指令，沒有任何警告", async () => {
    const fakes = await makeFakes();
    const dataDir = await makeTempDir();
    const result = run(fakes, { FAKE_UID: "10001", DATA_DIR: dataDir }, FINAL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("final uid=10001 a1=[has space] a2=[second]");
    expect(result.stderr).toBe("");
    expect((await readFile(fakes.log, "utf8")).trim()).toBe("");
  });

  it("非 root 啟動、資料目錄不存在：印警告但不退出，照樣執行原本的指令", async () => {
    const fakes = await makeFakes();
    const result = run(fakes, { FAKE_UID: "10001", DATA_DIR: join(await makeTempDir(), "missing") }, FINAL);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("警告");
    expect(result.stderr).toContain("不可寫");
    expect(result.stdout).toContain("final uid=10001");
  });

  it.skipIf(isRoot)("非 root 啟動、資料目錄唯讀：印警告但不退出（node 端會自己停用設定頁）", async () => {
    const fakes = await makeFakes();
    const dataDir = await makeTempDir();
    await chmod(dataDir, 0o500);
    const result = run(fakes, { FAKE_UID: "10001", DATA_DIR: dataDir }, FINAL);
    await chmod(dataDir, 0o700);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("不可寫");
    expect(result.stderr).toContain(dataDir); // 警告訊息裡有帶資料目錄的路徑（${DATA_DIR} 展開正常）
    expect(result.stdout).toContain("final uid=10001");
  });

  it("要執行的指令本身失敗時，入口腳本的結束碼就是它的結束碼（exec，不吞掉）", async () => {
    const fakes = await makeFakes();
    const result = run(fakes, { FAKE_UID: "10001", DATA_DIR: await makeTempDir() }, ["sh", "-c", "exit 7"]);
    expect(result.status).toBe(7);
  });
});
