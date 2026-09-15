// 纸坊客户纸样打样与确认台 —— 领域模型与状态机
// 零依赖，仅用 Node 内置模块。所有业务规则集中在本文件，HTTP 层与存储层不夹带规则。

export const SCHEMA_VERSION = 2;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// ---- 用户与角色 ----
// 一个用户可兼有多个角色；检测人不能复核自己的试样按用户 id 判定。
export const ROLE_LABELS = {
  submitter: "送样员",
  inspector: "检测员",
  reviewer: "复核员",
  customer: "客户",
};

export const USERS = [
  { id: "u-shen", name: "沈师傅", roles: ["submitter"] },
  { id: "u-yan", name: "严检", roles: ["inspector"] },
  { id: "u-ce", name: "策检", roles: ["inspector"] },
  { id: "u-fu", name: "傅核", roles: ["reviewer"] },
  { id: "u-jian", name: "季双", roles: ["inspector", "reviewer"] },
  { id: "c-jinfeng", name: "锦封文创·苏掌柜", roles: ["customer"], customerId: "cus-jinfeng" },
  { id: "c-yunmo", name: "云墨书院·李先生", roles: ["customer"], customerId: "cus-yunmo" },
];

export const DEFAULT_CUSTOMERS = [
  { id: "cus-jinfeng", name: "锦封文创", contact: "苏掌柜" },
  { id: "cus-yunmo", name: "云墨书院", contact: "李先生" },
];

// ---- 检测项与默认公差 ----
// 尺寸/厚度同时登记目标值与公差（打样单登记时可覆盖默认公差）。
// 纹理为枚举匹配；色差登记可接受 ΔE。
export const TEXTURES = ["棉料细纹理", "竹浆粗纹理", "构皮布纹", "龙须草平纹"];
export const DIMENSION_ITEMS = ["length", "width"];
export const NUMERIC_ITEMS = ["length", "width", "thickness", "deltaE"];
export const ALL_ITEMS = ["length", "width", "thickness", "texture", "deltaE"];
export const ITEM_LABELS = {
  length: "长(mm)",
  width: "宽(mm)",
  thickness: "厚度(μm)",
  texture: "纹理",
  deltaE: "色差ΔE",
};
export const NUMERIC_LABELS = {
  length: "长",
  width: "宽",
  thickness: "厚度",
  deltaE: "色差",
};
// 未显式给公差时的默认公差
export const DEFAULT_TOLERANCE = {
  length: 2, // mm
  width: 2,
  thickness: 5, // μm
  deltaE: 1.5, // ΔE 单边上限
};

// ---- 轮次状态机 ----
// 待送样 → 待检测 → 待复核 → 已确认
//   待检测 --检测超差/缺项(不受理, 留在待检测)--> 待检测
//   待复核 --驳回--> 已驳回；已驳回 --修订--> 新轮(待送样)
// 已确认为终态：该版本锁定，任何写入拒绝，修改须新建版本。
export const ROUND_STATUS = {
  DRAFT: "待送样",
  PENDING_TEST: "待检测",
  PENDING_REVIEW: "待复核",
  PENDING_CONFIRM: "待确认",
  REJECTED: "已驳回",
  CONFIRMED: "已确认",
};
export const ROUND_STATUS_FLOW = [
  ROUND_STATUS.DRAFT,
  ROUND_STATUS.PENDING_TEST,
  ROUND_STATUS.PENDING_REVIEW,
  ROUND_STATUS.PENDING_CONFIRM,
  ROUND_STATUS.REJECTED,
  ROUND_STATUS.CONFIRMED,
];

// 偏差分级：按各数值检测项 |实测-目标|/公差 的最大占比。
export function deviationRatio(round) {
  if (!round || !round.test) return null;
  let max = 0;
  let found = false;
  for (const key of NUMERIC_ITEMS) {
    const v = round.test.values?.[key];
    const target = round.spec[key];
    const tol = round.spec.tolerance?.[key];
    if (v == null || target == null || !tol) continue;
    found = true;
    const excess = key === "deltaE"
      ? Math.max(0, Number(v) - Number(target)) // 色差只罚超出上限
      : Math.abs(Number(v) - Number(target));
    max = Math.max(max, excess / tol);
  }
  return found ? max : null;
}

export function deviationGrade(round) {
  const r = deviationRatio(round);
  if (r == null) return "untested";
  if (r <= 0.5) return "within_half";
  if (r <= 1) return "within";
  return "out";
}

export const GRADE_LABELS = {
  within_half: "偏差≤半公差",
  within: "偏差半至全公差",
  out: "超差",
  untested: "无检测值",
};

// 复核通过后，本轮规格即为锁定版本的快照内容
export function snapshotFromRound(order, round) {
  return JSON.parse(JSON.stringify({
    purpose: order.purpose,
    customerId: order.customerId,
    spec: round.spec,
    roundNo: round.roundNo,
    test: round.test ? {
      values: round.test.values,
      inspectorId: round.test.inspectorId,
      inspectorName: round.test.inspectorName,
      testedAt: round.test.testedAt,
    } : null,
  }));
}

export function orderStatus(order) {
  const latest = order.rounds[order.rounds.length - 1];
  if (latest.status === ROUND_STATUS.CONFIRMED) return ROUND_STATUS.CONFIRMED;
  if (latest.status === ROUND_STATUS.REJECTED) return ROUND_STATUS.REJECTED;
  return "进行中";
}

export function genOrderCode(seq) {
  return "DY" + String(2600 + seq);
}
