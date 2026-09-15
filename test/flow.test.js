// 全流程：建档→送样→检测→复核→驳回→修订→复核→确认→锁定→新版本；并含旧轮只读与比较
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness, goodSpec, passValues, happyPath, expectError, U } from "./helpers.js";

test("完整走通：送样→检测→复核驳回→修订→通过→确认锁定→新版本", async () => {
  const h = await makeHarness();
  try {
    const created = await h.svc.createOrder(U["u-shen"], goodSpec());
    assert.equal(created.status, "进行中");
    assert.equal(created.rounds.length, 1);
    assert.equal(created.rounds[0].status, "待送样");

    // 规格公差默认值已落
    assert.equal(created.rounds[0].spec.tolerance.length, 2);

    const submitted = await h.svc.submitSpecimen(U["u-shen"], created.id, { expectedRevision: created.revision });
    assert.equal(submitted.rounds[0].status, "待检测");

    // 检测缺项拒绝
    await expectError(
      h.svc.submitTest(U["u-yan"], created.id, { values: { length: 297 } }),
      "missing_fields",
    );

    // 超差拒绝（长度 300，目标297±2 → 超3）
    await expectError(
      h.svc.submitTest(U["u-yan"], created.id, { values: passValues({ length: 300 }) }),
      "out_of_tolerance",
    );

    // 完整合格检测值
    const tested = await h.svc.submitTest(U["u-yan"], created.id, { values: passValues() });
    assert.equal(tested.rounds[0].status, "待复核");
    assert.equal(tested.rounds[0].grade, "within_half");

    // 复核驳回
    let r = await h.svc.review(U["u-fu"], created.id, { decision: "reject", reason: "纸面有轻微杂质" });
    assert.equal(r.rounds[0].status, "已驳回");
    const rev1 = r.revision;

    // 已驳回轮上再送检：越序拒绝
    await expectError(h.svc.submitSpecimen(U["u-shen"], created.id, {}), "out_of_order");
    // 直接检测：越序拒绝
    await expectError(h.svc.submitTest(U["u-yan"], created.id, { values: passValues() }), "out_of_order");

    // 新建修订轮（调厚一点）
    r = await h.svc.newRevision(U["u-shen"], created.id, { expectedRevision: rev1, thickness: 125 });
    assert.equal(r.rounds.length, 2);
    assert.equal(r.rounds[1].roundNo, 2);
    assert.equal(r.rounds[1].status, "待送样");
    assert.equal(r.rounds[1].spec.thickness, 125);
    // 旧轮只读：仍为已驳回、检测数据保留
    assert.equal(r.rounds[0].status, "已驳回");
    assert.ok(r.rounds[0].test);

    // 第二轮走完
    r = await h.svc.submitSpecimen(U["u-shen"], created.id, { expectedRevision: r.revision });
    r = await h.svc.submitTest(U["u-ce"], created.id, { expectedRevision: r.revision, values: passValues({ thickness: 124 }) });
    assert.equal(r.rounds[1].status, "待复核");
    r = await h.svc.review(U["u-fu"], created.id, { expectedRevision: r.revision, decision: "approve" });
    assert.equal(r.rounds[1].status, "待确认");
    r = await h.svc.customerConfirm(U["c-jinfeng"], created.id, { expectedRevision: r.revision, decision: "approve" });
    assert.equal(r.status, "已确认");
    assert.equal(r.rounds[1].status, "已确认");

    // 确认后：送检/检测/修订/复核全部拒绝（锁定/越序）
    await expectError(h.svc.submitSpecimen(U["u-shen"], created.id, {}), "locked_version");
    await expectError(h.svc.newRevision(U["u-shen"], created.id, {}), "out_of_order");

    // 生成新版本
    const v2 = await h.svc.newVersion(U["u-shen"], created.id, { expectedRevision: r.revision, length: 300 });
    assert.equal(v2.specVersion, 2);
    assert.equal(v2.rounds.length, 1);
    assert.equal(v2.rounds[0].roundNo, 1);
    assert.equal(v2.rounds[0].spec.length, 300);
    assert.equal(v2.versions.length, 1);
    assert.equal(v2.versions[0].rounds.length, 2); // 旧版两轮完整归档
    assert.equal(v2.versions[0].rounds[1].status, "已确认"); // 归档只读

    // 旧版与当前版并排比较
    const cmp = await h.svc.compare(U["u-shen"], created.id,
      { version: 1, roundNo: 1 }, { version: 2, roundNo: 1 });
    assert.equal(cmp.a.archived, true);
    assert.equal(cmp.a.spec.length, 297);
    assert.equal(cmp.b.archived, false);
    assert.equal(cmp.b.spec.length, 300);
  } finally {
    await h.close();
  }
});

test("检测判废路径：完整值且确有超差才能判废，随后修订重来", async () => {
  const h = await makeHarness();
  try {
    const o = await h.svc.createOrder(U["u-shen"], goodSpec({ purpose: "册页函套" }));
    await h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: o.revision });

    // 缺原因
    await expectError(
      h.svc.rejectAsInspector(U["u-yan"], o.id, { values: passValues({ length: 300 }) }),
      "missing_fields",
    );
    // 值合格却判废 → 拒绝
    await expectError(
      h.svc.rejectAsInspector(U["u-yan"], o.id, { reason: "不行", values: passValues() }),
      "not_out_of_tolerance",
    );
    // 缺项判废 → 拒绝
    await expectError(
      h.svc.rejectAsInspector(U["u-yan"], o.id, { reason: "不行", values: { length: 300 } }),
      "missing_fields",
    );
    const rej = await h.svc.rejectAsInspector(U["u-yan"], o.id, {
      reason: "长度超差3mm", values: passValues({ length: 300 }),
    });
    assert.equal(rej.rounds.at(-1).status, "已驳回");
    assert.equal(rej.rounds.at(-1).rejection.stage, "检测");
    assert.ok(rej.rounds.at(-1).test.failed);

    const rev = await h.svc.newRevision(U["u-shen"], o.id, { expectedRevision: rej.revision });
    assert.equal(rev.rounds.at(-1).status, "待送样");
  } finally {
    await h.close();
  }
});

test("客户驳回也强制新建修订轮；客户只可见本客户数据", async () => {
  const h = await makeHarness();
  try {
    const hp = await happyPath(h.svc, { confirm: false });
    const rejected = await h.svc.customerConfirm(U["c-jinfeng"], hp.id, {
      expectedRevision: hp.snaps.reviewed.revision, decision: "reject", reason: "纹理与封样不符",
    });
    assert.equal(rejected.rounds.at(-1).status, "已驳回");
    const rev = await h.svc.newRevision(U["u-shen"], hp.id, { expectedRevision: rejected.revision });
    assert.equal(rev.rounds.length, 2);

    // 另一客户看不到该单
    const rows = await h.svc.listAndStats(U["c-yunmo"], { version: "all" });
    assert.equal(rows.rows.length, 0);
    const mine = await h.svc.listAndStats(U["c-jinfeng"], { version: "all" });
    assert.ok(mine.rows.length >= 2); // 修订后第1、2轮均在册
  } finally {
    await h.close();
  }
});

test("待送样阶段可改规格；越权角色建档拒绝", async () => {
  const h = await makeHarness();
  try {
    await expectError(h.svc.createOrder(U["u-yan"], goodSpec()), "forbidden");
    const o = await h.svc.createOrder(U["u-shen"], goodSpec());
    const e = await h.svc.editSpec(U["u-shen"], o.id, { expectedRevision: o.revision, length: 280 });
    assert.equal(e.rounds[0].spec.length, 280);
    await h.svc.submitSpecimen(U["u-shen"], o.id, { expectedRevision: e.revision });
    // 送检后改规格：越序
    await expectError(
      h.svc.editSpec(U["u-shen"], o.id, { expectedRevision: e.revision + 1, length: 281 }),
      "out_of_order",
    );
  } finally {
    await h.close();
  }
});
