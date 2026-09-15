// 存储层：JSON 文件持久化
// - 所有写操作经串行队列执行（进程内并发安全）
// - 原子写：先写 *.tmp 再 rename，避免半文件
// - 事务：变更前在内存快照上执行，提交点失败注入可整体回滚
// - schemaVersion 迁移：旧版本数据自动升级，字段补齐
import { rename, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_VERSION, DEFAULT_CUSTOMERS, USERS } from "./domain.js";

export function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: 0,
    customers: JSON.parse(JSON.stringify(DEFAULT_CUSTOMERS)),
    orders: [],
  };
}

// ---- 旧数据兼容迁移 ----
// v1 → v2：
//  - 打样单增加用途(purpose)/规格版本号(specVersion)；旧单视为 第1版
//  - 轮次增加 revision 乐观锁；旧轮补 0
//  - 已存在但缺省公差的检测项补齐默认公差
//  - 色差旧字段名 colorDiff 统一为 deltaE
function migrate(raw) {
  const warnings = [];
  let db = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (db == null || typeof db !== "object") throw new Error("数据文件格式损坏：根节点不是对象");

  if (!Array.isArray(db.orders)) {
    // 更早的结构：{items:[...]}（异业旧脚手架数据）—— 不识别为打样数据，从空库起步但保留警告
    if (Array.isArray(db.items)) {
      warnings.push("检测到旧版台账数据(items)，与打样台不兼容，已归档为空库初始状态");
    }
    db = emptyDb();
    db.migrationWarnings = warnings;
    return db;
  }

  const fromVersion = Number(db.schemaVersion || 1);
  db.schemaVersion = SCHEMA_VERSION;
  db.seq = Number(db.seq || 0);
  if (!Array.isArray(db.customers)) db.customers = JSON.parse(JSON.stringify(DEFAULT_CUSTOMERS));

  for (const order of db.orders) {
    if (fromVersion < 2) {
      if (!order.purpose) order.purpose = order.usage || order.purposeName || "未登记用途";
      if (order.specVersion == null) order.specVersion = 1;
      if (order.version == null) order.version = 1;
    }
    order.specVersion = Number(order.specVersion || 1);
    order.version = Number(order.version || order.specVersion);
    if (!Array.isArray(order.rounds)) order.rounds = [];
    if (!Array.isArray(order.events)) order.events = [];
    if (!Array.isArray(order.snapshots)) order.snapshots = [];

    for (const round of order.rounds) {
      if (round.revision == null) round.revision = 0;
      // 旧字段名兼容：colorDiff → deltaE
      if (round.spec?.deltaE == null && round.spec?.colorDiff != null) {
        round.spec.deltaE = round.spec.colorDiff;
        delete round.spec.colorDiff;
      }
      if (round.test?.values?.deltaE == null && round.test?.values?.colorDiff != null) {
        round.test.values.deltaE = round.test.values.colorDiff;
        delete round.test.values.colorDiff;
      }
      round.spec.tolerance ||= {};
      for (const [k, v] of Object.entries({ length: 2, width: 2, thickness: 5, deltaE: 1.5 })) {
        if (round.spec.tolerance[k] == null && round.spec[k] != null) round.spec.tolerance[k] = v;
      }
      round.status ||= "待送样";
    }
  }
  if (fromVersion < SCHEMA_VERSION) warnings.push(`数据已从 schema v${fromVersion} 迁移至 v${SCHEMA_VERSION}`);
  db.migrationWarnings = warnings;
  return db;
}

export class Store {
  constructor(file, { failpoint = null } = {}) {
    this.file = file;
    this.failpoint = failpoint; // 例：{name:'beforeCommit', once:true}
    this.chain = Promise.resolve();
    this.db = null;
  }

  async init() {
    if (existsSync(this.file)) {
      const raw = await readFile(this.file, "utf8");
      const migrated = migrate(raw);
      this.db = migrated;
      // 迁移结果立即规范化落盘（旧文件升级为新 schema）；已是最新时写入内容等价
      if ((migrated.migrationWarnings || []).length) {
        await this._persist(migrated);
      }
    } else {
      this.db = emptyDb();
      await this._persist();
    }
    return this.db;
  }

  // 仅供测试：故障注入开关
  setFailpoint(fp) { this.failpoint = fp; }

  _hit(name) {
    if (!this.failpoint || this.failpoint.name !== name) return false;
    if (this.failpoint.once) this.failpoint = null;
    return true;
  }

  async _persist(db = this.db) {
    if (this._hit("beforePersist")) throw new Error("模拟落盘失败（beforePersist）");
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    await writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    if (this._hit("afterTmpWrite")) throw new Error("模拟落盘失败（afterTmpWrite）");
    await rename(tmp, this.file);
  }

  // 串行化读：与写互斥视角一致（写操作中途不对外暴露中间态）
  read(fn) {
    return this.chain.then(() => fn(this.db));
  }

  // 事务：fn 在深拷贝快照上执行，返回结果；先原子落盘，成功后才替换内存库。
  // 任一步失败：内存库保持上一版（回滚），正式文件也保持上一版（tmp 残留由下次写入覆盖）。
  mutate(fn, { label = "mutate" } = {}) {
    const run = this.chain.then(async () => {
      const snapshot = JSON.parse(JSON.stringify(this.db));
      let result;
      result = await fn(snapshot); // 规则校验失败：快照被丢弃
      if (this._hit("beforeCommit")) throw new Error("模拟提交失败（beforeCommit）：" + label);
      await this._persist(snapshot); // 落盘失败：this.db 未被替换
      this.db = snapshot;           // 提交点：落盘成功后才生效
      if (this._hit("afterCommit")) throw new Error("模拟提交后异常（afterCommit）：" + label);
      return result;
    });
    // 串行链不因单次失败中断
    this.chain = run.then(() => {}, () => {});
    return run;
  }
}

export { USERS };
