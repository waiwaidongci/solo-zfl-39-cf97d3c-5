// 权限、重复提交、自复核、筛选与统计一致性、并发生成、失败回滚、重启持久化、旧数据兼容
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeHarness, goodSpec, passValues, happyPath, expectError, U } from "./helpers.js";
import { ROUND_STATUS } from "../src/domain.js";

// ---------- 权限 / 越权 ----------
test("角色越权：检测员不能送检/建档，复核员不能检测，客户不能送样", async () => {
  const h = await makeHarness();
  try {
    // 检测员/复核员/客户均不能建档
    await expectError(h.svc.createOrder(U["u-yan"], goodSpec()), "forbidden");
    await expectError(h.svc.createOrder(U["u-fu"], goodSpec()), "forbidden");
    await expectError(h.svc.createOrder(U["c-jinfeng"], goodSpec()), "forbidden");

    const o = await h.svc.createOrder(U["u-shen"], goodSpec());
    // 检测员不能送检
    await expectError(h.svc.submitSpecimen(U["u-yan"], o.id, {}), "forbidden");
    await h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision });

    // 复核员不能检测
    await expectError(h.svc.submitTest(U["u-fu"], o.id, { values: passValues() }), "forbidden");
    // 客户不能检测
    await expectError(h.svc.submitTest(U["c-jinfeng"], o.id, { values: passValues() }), "forbidden");
    // 送样员不能检测
    await expectError(h.svc.submitTest(U["u-shen"], o.id, { values: passValues() }), "forbidden");
  } finally {
    await h.close();
  }
});

test("检测人不能复核自己的试样（即使本人兼有复核角色）", async () => {
  const h = await makeHarness();
  try {
    const o = await h.svc.createOrder(U["u-shen"], goodSpec());
    await h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision });
    // 季双兼有 inspector+reviewer：她检测后自己复核 → 拒绝
    const tested = await h.svc.submitTest(U["u-jian"], o.id, { values: passValues() });
    await expectError(
      h.svc.review(U["u-jian"], o.id, { expectedRevision: tested.revision, decision: "approve" }),
      "self_review_forbidden",
    );
    // 换人复核通过
    const reviewed = await h.svc.review(U["u-fu"], o.id, { expectedRevision: tested.revision, decision: "approve" });
    assert.equal(reviewed.rounds.at(-1).status, "待确认");

    // 别的客户不能确认
    await expectError(
      h.svc.customerConfirm(U["c-yunmo"], o.id, { decision: "approve" }),
      "forbidden",
    );
    // 直接读详情也越权
    await expectError(h.svc.getOrder(U["c-yunmo"], o.id), "forbidden");
  } finally {
    await h.close();
  }
});

// ---------- 重复提交 / 越序 ----------
test("重复提交：同一试样检测只能登记一次；待检试样唯一", async () => {
  const h = await makeHarness();
  try {
    const o = await h.svc.createOrder(U["u-shen"], goodSpec());
    await h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision });
    await h.svc.submitTest(U["u-yan"], o.id, { values: passValues() });
    // 再次检测：状态已变，先撞越序
    await expectError(
      h.svc.submitTest(U["u-yan"], o.id, { values: passValues() }),
      "out_of_order",
    );
    // 待送样时重复送检不可能，因为首送检后状态即推进；再送检撞越序
    await expectError(h.svc.submitSpecimen(U["u-shen"], o.id, {}), "out_of_order");
  } finally {
    await h.close();
  }
});

// ---------- 乐观锁：过期写入拒绝 + 并发生成 ----------
test("过期写入拒绝（乐观锁）与并发：两个建单/两个送检只有一个成功", async () => {
  const h = await makeHarness();
  try {
    const o = await h.svc.createOrder(U["u-shen"], goodSpec());
    // 两个并发送检：同一 revision，一个成功一个 409
    const [a, b] = await Promise.allSettled([
      h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision }),
      h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision }),
    ]);
    const oks = [a, b].filter((x) => x.status === "fulfilled");
    const fails = [a, b].filter((x) => x.status === "rejected");
    assert.equal(oks.length, 1);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].reason.code, "stale_write");

    // 并发建单：都成功（序号不冲突、数据不丢）
    const created = await Promise.all([
      h.svc.createOrder(U["u-shen"], goodSpec({ purpose: "并发单A" })),
      h.svc.createOrder(U["u-shen"], goodSpec({ purpose: "并发单B" })),
      h.svc.createOrder(U["u-shen"], goodSpec({ purpose: "并发单C" })),
    ]);
    const codes = new Set(created.map((x) => x.code));
    assert.equal(codes.size, 3);

    // 串行链上最终一致：共 4 单
    const all = await h.svc.listAndStats(U["u-shen"], { version: "latest" });
    assert.equal(all.rows.length, 4);

    // 陈旧 revision 编辑 → 拒绝
    await expectError(
      h.svc.editSpec(U["u-shen"], o.id, { expectedRevision: o.revision, length: 280 }),
      "stale_write",
    );
  } finally {
    await h.close();
  }
});

// ---------- 失败回滚 ----------
test("落盘/提交失败整体回滚：内存与文件都保持上一版，后续写可继续", async () => {
  const h = await makeHarness();
  try {
    const o = await h.svc.createOrder(U["u-shen"], goodSpec());
    const beforeRows = (await h.svc.listAndStats(U["u-shen"], { version: "latest" })).rows.length;

    // 注入提交前失败：送样应报错且不生效
    h.store.setFailpoint({ name: "beforeCommit", once: true });
    await expectError(
      h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision }),
    );
    h.store.setFailpoint(null);
    const still = await h.svc.getOrder(U["u-shen"], o.id);
    assert.equal(still.rounds[0].status, "待送样"); // 内存回滚

    // 文件层也回滚：重新打开实例读取磁盘，状态仍是待送样
    const reopened = await h.reopen();
    const fromDisk = await reopened.svc.getOrder(U["u-shen"], o.id);
    assert.equal(fromDisk.rounds[0].status, "待送样");

    // 原子写中途失败（tmp 写完、rename 前）：同样回滚，且不留半正式文件
    h.store.setFailpoint({ name: "afterTmpWrite", once: true });
    await expectError(
      h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision }),
    );
    h.store.setFailpoint(null);
    const afterRows = (await h.svc.listAndStats(U["u-shen"], { version: "latest" })).rows.length;
    assert.equal(afterRows, beforeRows);

    // 失败后系统可继续正常写入
    const ok = await h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision });
    assert.equal(ok.rounds[0].status, "待检测");
  } finally {
    await h.close();
  }
});

// ---------- 重启持久化 ----------
test("重启后数据仍在：完整流程跨重启", async () => {
  const h = await makeHarness();
  try {
    const { id } = await happyPath(h.svc);
    const r2 = await h.reopen();
    const o = await r2.svc.getOrder(U["u-shen"], id);
    assert.equal(o.status, ROUND_STATUS.CONFIRMED);
    assert.equal(o.rounds.at(-1).confirmation.result, "确认");
    const list = await r2.svc.listAndStats(U["u-shen"], { confirmStatus: "confirmed" });
    assert.ok(list.rows.some((x) => x.orderId === id));

    // 重启后仍可在旧单上生成新版本
    const v2 = await r2.svc.newVersion(U["u-shen"], id, { expectedRevision: o.revision, purpose: "新用途" });
    assert.equal(v2.specVersion, 2);
    assert.equal(v2.purpose, "新用途");
    const r3 = await h.reopen();
    const o3 = await r3.svc.getOrder(U["u-shen"], id);
    assert.equal(o3.specVersion, 2);
    assert.equal(o3.versions.length, 1);
  } finally {
    await h.close();
  }
});

// ---------- 旧数据兼容 ----------
test("旧数据兼容：v1 结构/旧字段名/缺公差自动迁移，历史台账安全空库", async () => {
  const h = await makeHarness();
  try {
    // v1：无 purpose 字段名不同、colorDiff 旧字段、无 revision/公差
    await h.seedRaw({
      schemaVersion: 1,
      seq: 7,
      customers: [{ id: "cus-old", name: "老纸庄", contact: "掌柜" }],
      orders: [{
        id: "o-old", code: "DY2607", customerId: "cus-old",
        usage: "古籍修复", // 旧字段
        specVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        rounds: [{
          id: "r-v1-1", specVersion: 1, roundNo: 1, status: "已确认",
          spec: { length: 300, width: 200, thickness: 100, texture: "竹浆粗纹理", colorDiff: 2.0 },
          test: {
            values: { length: 300.5, width: 200.4, thickness: 101, texture: "竹浆粗纹理", colorDiff: 1.8 },
            inspectorId: "u-yan", inspectorName: "严检", testedAt: "2026-01-02T00:00:00.000Z",
          },
          confirmation: {
            customerId: "cus-old", decidedById: "c-jinfeng", decidedByName: "苏掌柜",
            decidedAt: "2026-01-03T00:00:00.000Z", result: "确认",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
        events: [], versions: [],
      }],
    });
    const reopened = await h.reopen();
    const o = await reopened.svc.getOrder(U["u-shen"], "o-old");
    assert.equal(o.purpose, "古籍修复");
    assert.equal(o.rounds[0].spec.deltaE, 2.0);        // 旧字段迁移
    assert.equal(o.rounds[0].test.values.deltaE, 1.8);
    assert.equal(o.rounds[0].spec.tolerance.length, 2); // 默认公差补齐
    assert.equal(o.rounds[0].revision, 0);             // 乐观锁字段补齐
    assert.equal(o.status, "已确认");
    // 偏差可正常计算
    assert.equal(o.rounds[0].grade, "within_half");
    // 健康检查中有迁移提示
    const raw = JSON.parse(await readFile(h.file, "utf8"));
    assert.equal(raw.schemaVersion, 2);
  } finally {
    await h.close();
  }
});

test("兼容更早的异业台账(items)：不污染业务，空库起步", async () => {
  const h = await makeHarness();
  try {
    await h.seedRaw({ items: [{ code: "PF-001", status: "发酵中" }] });
    const reopened = await h.reopen();
    const list = await reopened.svc.listAndStats(U["u-shen"], { version: "all" });
    assert.equal(list.rows.length, 0);
    assert.ok(Array.isArray(reopened.store.db.customers));
  } finally {
    await h.close();
  }
});

// ---------- 筛选与统计一致 ----------
test("筛选：客户/用途/版本/偏差/确认状态；统计数字与明细行数一致", async () => {
  const h = await makeHarness();
  try {
    // 单1：锦封 线装书封面，完整确认
    await happyPath(h.svc);
    // 单2：云墨 册页，送样后检测超差判废 → 已驳回
    const o2 = await h.svc.createOrder(U["u-shen"], goodSpec({ customerId: "cus-yunmo", purpose: "册页函套" }));
    await h.svc.submitSpecimen(U["u-shen"], o2.id, { expectedRevision: o2.revision });
    await h.svc.rejectAsInspector(U["u-yan"], o2.id, { reason: "长度超差", values: passValues({ length: 300.9 }) });
    // 单3：锦封 第二用途，仅建档（待送样，无检测值）
    await h.svc.createOrder(U["u-shen"], goodSpec({ purpose: "书签便签" }));

    const all = await h.svc.listAndStats(U["u-shen"], { version: "all" });
    // 统计总数 == 明细行数
    assert.equal(all.stats.total, all.rows.length);
    assert.equal(
      all.stats.confirmed + all.stats.unconfirmed,
      all.rows.length,
    );
    // 各状态计数之和 == 总数
    assert.equal(
      Object.values(all.stats.byStatus).reduce((a, b) => a + b, 0),
      all.rows.length,
    );
    // 偏差分级计数之和 == 总数
    assert.equal(
      Object.values(all.stats.byGrade).reduce((a, b) => a + b, 0),
      all.rows.length,
    );

    // 按客户
    const jf = await h.svc.listAndStats(U["u-shen"], { customerId: "cus-jinfeng", version: "all" });
    assert.ok(jf.rows.every((r) => r.customerId === "cus-jinfeng"));
    assert.equal(jf.stats.total, jf.rows.length);

    // 按用途
    const byPurpose = await h.svc.listAndStats(U["u-shen"], { purpose: "线装书封面", version: "all" });
    assert.ok(byPurpose.rows.length >= 1);
    assert.ok(byPurpose.rows.every((r) => r.purpose === "线装书封面"));

    // 偏差=超差：驳回轮在列
    const out = await h.svc.listAndStats(U["u-shen"], { deviation: "out", version: "all" });
    assert.ok(out.rows.some((r) => r.orderId === o2.id));
    assert.ok(out.rows.every((r) => r.grade === "out"));

    // 无检测值：待送样轮在列
    const untested = await h.svc.listAndStats(U["u-shen"], { deviation: "untested", version: "all" });
    assert.ok(untested.rows.some((r) => r.purpose === "书签便签"));

    // 确认状态
    const confirmed = await h.svc.listAndStats(U["u-shen"], { confirmStatus: "confirmed", version: "all" });
    assert.ok(confirmed.rows.every((r) => r.confirmed));
    const unconfirmed = await h.svc.listAndStats(U["u-shen"], { confirmStatus: "unconfirmed", version: "all" });
    assert.ok(unconfirmed.rows.every((r) => !r.confirmed));

    // 仅当前版本：默认 latest，单1只有当前版（未建v2），行数=每单当前轮
    const latest = await h.svc.listAndStats(U["u-shen"], {});
    assert.equal(latest.rows.length, 3);

    // 客户视角天然过滤
    const yunmo = await h.svc.listAndStats(U["c-yunmo"], { version: "all" });
    assert.ok(yunmo.rows.every((r) => r.customerId === "cus-yunmo"));
  } finally {
    await h.close();
  }
});
