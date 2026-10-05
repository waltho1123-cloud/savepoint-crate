import { summarizeAdmins } from "./admins.js";
import type { FetchLike, Logger } from "./common.js";
import type { AppEnv } from "./env.js";
import { fetchGroupName, type LineGroupEvent } from "./line.js";
import {
  CAPTURED_GROUPS_MAX,
  type AdminAccount,
  type CapturedGroup,
  type ReadonlySettings,
  type SettingsStore,
} from "./settings-store.js";

/**
 * 「實際生效的 LINE 設定」與設定頁用的檢視：設定頁存的設定檔優先，沒有的話退回環境變數。
 */

export type LineSource = "settings" | "env" | null;

export interface EffectiveLine {
  /** 設定來源：settings＝設定頁（設定檔裡有 token）；env＝環境變數（備援）；null＝兩邊都沒設定。 */
  source: LineSource;
  /** 關箱通知開關。環境變數來源沒有開關，恆為 true。 */
  enabled: boolean;
  token: string;
  secret: string;
  groupId: string;
  /** 關箱時會推播：開關開著，且 token 與群組 ID 都有。 */
  notifyReady: boolean;
  /** webhook 啟用：有 channel secret（開關不影響 webhook）。 */
  webhookReady: boolean;
}

/**
 * 解析規則：設定檔裡的 channel access token 不是空的，就整組（token、secret、群組 ID、開關）用設定檔的，
 * 環境變數完全不參與（避免兩邊各取一半、搞不清楚到底用哪一組）；否則整組用環境變數。
 */
export function resolveLineConfig(env: AppEnv, data: ReadonlySettings): EffectiveLine {
  const file = data.line;
  if (file.channelAccessToken !== "") {
    return {
      source: "settings",
      enabled: file.enabled,
      token: file.channelAccessToken,
      secret: file.channelSecret,
      groupId: file.groupId,
      notifyReady: file.enabled && file.groupId !== "",
      webhookReady: file.channelSecret !== "",
    };
  }
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = env.LINE_CHANNEL_SECRET;
  const groupId = env.LINE_GROUP_ID;
  const anyEnv = token !== "" || secret !== "" || groupId !== "";
  return {
    source: anyEnv ? "env" : null,
    enabled: true,
    token,
    secret,
    groupId,
    notifyReady: token !== "" && groupId !== "",
    webhookReady: secret !== "",
  };
}

// ===================================================================== 設定頁／設定 API 的檢視

/** token／secret 只顯示「是否已設定」與末 4 碼（太短的值不顯示尾碼，免得洩漏過半）；永遠不回傳完整內容。 */
export interface MaskedCredential {
  configured: boolean;
  last4: string | null;
}

export function maskCredential(value: string): MaskedCredential {
  return { configured: value !== "", last4: value.length >= 12 ? value.slice(-4) : null };
}

export interface SettingsView {
  dataDirWritable: boolean;
  /** 資料目錄是否在獨立掛載的 Volume 上；null＝判斷不出來。 */
  dataDirMounted: boolean | null;
  /** 有啟用中的管理員，或仍有待升級的舊版單一密碼（和 /healthz 同一個判斷）。 */
  adminConfigured: boolean;
  /** 管理員帳號總數（含停用的）。 */
  adminCount: number;
  legacyAdminPending: boolean;
  /** 目前登入的管理員。 */
  me: { id: string; name: string; email: string };
  line: {
    enabled: boolean;
    channelAccessToken: MaskedCredential;
    channelSecret: MaskedCredential;
    groupId: string;
    groupName: string;
    updatedAt: string;
  };
  effective: {
    source: LineSource;
    lineConfigured: boolean;
    lineWebhookConfigured: boolean;
  };
  /** 環境變數備援有沒有值（只有有／沒有，不含內容）。 */
  env: { tokenConfigured: boolean; groupIdConfigured: boolean; secretConfigured: boolean };
  captured: CapturedGroup[];
}

export function buildSettingsView(env: AppEnv, store: SettingsStore, me: Pick<AdminAccount, "id" | "name" | "email">): SettingsView {
  const data = store.data;
  const effective = resolveLineConfig(env, data);
  return {
    dataDirWritable: store.writable,
    dataDirMounted: store.mounted,
    ...summarizeAdmins(data),
    me: { id: me.id, name: me.name, email: me.email },
    line: {
      enabled: data.line.enabled,
      channelAccessToken: maskCredential(data.line.channelAccessToken),
      channelSecret: maskCredential(data.line.channelSecret),
      groupId: data.line.groupId,
      groupName: data.line.groupName,
      updatedAt: data.line.updatedAt,
    },
    effective: {
      source: effective.source,
      lineConfigured: effective.notifyReady,
      lineWebhookConfigured: effective.webhookReady,
    },
    env: {
      tokenConfigured: env.LINE_CHANNEL_ACCESS_TOKEN !== "",
      groupIdConfigured: env.LINE_GROUP_ID !== "",
      secretConfigured: env.LINE_CHANNEL_SECRET !== "",
    },
    captured: data.lineCaptured.map((group) => ({
      groupId: group.groupId,
      groupName: group.groupName,
      eventType: group.eventType,
      lastSeenAt: group.lastSeenAt,
    })),
  };
}

// ===================================================================== webhook：記錄最近收到的群組

/** 同一個群組的 message 事件，多久內不重複處理（join 事件不受限）：繁忙的群組不能每則訊息都寫一次磁碟、查一次名稱。 */
export const CAPTURE_REFRESH_MS = 10 * 60 * 1000;
/** 節流表最多記幾個群組（超過就丟掉最舊的）；群組 ID 都經過格式驗證（≤ 64 字元），記憶體用量有上限。 */
export const CAPTURE_THROTTLE_MAX_ENTRIES = 1000;

export interface CaptureContext {
  store: SettingsStore;
  fetchImpl: FetchLike;
  log: Logger;
  /** 目前生效的 channel access token（用來查群組名稱；空字串就不查）。 */
  token: string;
  now: () => number;
  /**
   * 每個群組最後一次處理的時間（毫秒，記憶體內，由呼叫端建立並長期持有）。message 事件靠它節流，
   * 所以即使群組不在「最近 10 筆」名單裡（活躍群組超過 10 個）也不會每則訊息都查名稱、寫檔。
   */
  lastHandled: Map<string, number>;
}

/** 記下這個群組剛處理過（同時把它移到 Map 最後面，超過上限就丟掉最舊的）。 */
function rememberHandled(table: Map<string, number>, groupId: string, nowMs: number): void {
  table.delete(groupId);
  table.set(groupId, nowMs);
  if (table.size > CAPTURE_THROTTLE_MAX_ENTRIES) {
    const oldest = table.keys().next();
    if (!oldest.done) table.delete(oldest.value);
  }
}

/**
 * 記錄 webhook 收到的群組（join 或 message 事件）到設定檔的 lineCaptured：同一個群組去重、最新的在前、最多 10 筆。
 * message 事件對同一個群組 10 分鐘內只處理一次（join 事件不受限）；名稱沿用已記錄的，沒有才用 token 查
 * （join 事件一律重查，因為剛加入時最可能是新名字）。資料目錄不可用時什麼都不做。
 */
export async function captureLineGroup(ctx: CaptureContext, event: LineGroupEvent): Promise<void> {
  if (!ctx.store.writable) return;
  const nowMs = ctx.now();
  if (event.eventType === "message") {
    const last = ctx.lastHandled.get(event.groupId);
    // nowMs < last＝系統時鐘往回調：不當成「剛剛才處理過」，照常處理
    if (last !== undefined && nowMs >= last && nowMs - last < CAPTURE_REFRESH_MS) return;
  }
  rememberHandled(ctx.lastHandled, event.groupId, nowMs); // 先記，同一群組同時進來的事件不會重複處理
  const existing = ctx.store.data.lineCaptured.find((group) => group.groupId === event.groupId);
  let groupName = existing?.groupName ?? "";
  if (ctx.token !== "" && (groupName === "" || event.eventType === "join")) {
    const fetched = await fetchGroupName({ fetchImpl: ctx.fetchImpl, log: ctx.log, token: ctx.token }, event.groupId);
    if (fetched !== "") groupName = fetched;
  }
  const entry: CapturedGroup = {
    ...existing, // 同一個群組重新記錄時，保留這一筆原有的（包含不認識的）欄位
    groupId: event.groupId,
    groupName,
    eventType: event.eventType,
    lastSeenAt: new Date(nowMs).toISOString(),
  };
  await ctx.store.update((draft) => {
    draft.lineCaptured = [entry, ...draft.lineCaptured.filter((group) => group.groupId !== event.groupId)].slice(
      0,
      CAPTURED_GROUPS_MAX,
    );
  });
}
