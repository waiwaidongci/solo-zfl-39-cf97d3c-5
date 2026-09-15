// 测试公共工具：临时文件 + 内存服务 + 固定用户
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { makeService } from "../src/service.js";
import { USERS } from "../src/domain.js";

export const U = Object.fromEntries(USERS.map((u) => [u.id, u]));

export async function makeHarness() {
  const dir = await mkdtemp(join(tmpdir(), "pf-test-"));
  const file = join(dir, "db.json");
  const store = new Store(file);
  await store.init();
  const svc = makeService(store);
  return {
    dir, file, store, svc,
    async close() { await rm(dir, { recursive: true, force: true }); },
    async reopen(failpoint = null) {
      const s2 = new Store(file, failpoint ? { failpoint } : {});
      await s2.init();
      return { store: s2, svc: makeService(s2) };
    },
    async seedRaw(obj) { await writeFile(file, JSON.stringify(obj)); },
  };
}

export const goodSpec = (over = {}) => ({
  customerId: "cus-jinfeng",
  purpose: "线装书封面",
  length: 297, width: 210, thickness: 120,
  texture: "棉料细纹理",
  deltaE: 1.5,
  ...over,
});

export const passValues = (over = {}) => ({
  length: 297.5, width: 210.8, thickness: 122,
  texture: "棉料细纹理",
  deltaE: 1.0,
  ...over,
});

// 走通：建档→送样→检测→复核→（可选客户动作）。返回每一步订单快照。
export async function happyPath(svc, { confirm = true, customer = U["c-jinfeng"] } = {}) {
  const snaps = {};
  snaps.created = await svc.createOrder(U["u-shen"], goodSpec());
  const id = snaps.created.id;
  snaps.submitted = await svc.submitSpecimen(U["u-shen"], id, { expectedRevision: snaps.created.revision });
  snaps.tested = await svc.submitTest(U["u-yan"], id, { expectedRevision: snaps.submitted.revision, values: passValues() });
  snaps.reviewed = await svc.review(U["u-fu"], id, { expectedRevision: snaps.tested.revision, decision: "approve" });
  if (confirm) {
    snaps.confirmed = await svc.customerConfirm(customer, id, { expectedRevision: snaps.reviewed.revision, decision: "approve" });
  }
  return { id, snaps };
}

export async function expectError(p, code) {
  let err;
  try { await p; } catch (e) { err = e; }
  if (!err) throw new Error(`预期抛出 ${code}，但未抛错`);
  if (code && err.code !== code) throw new Error(`预期错误码 ${code}，实际 ${err.code}（${err.message}）`);
  return err;
}
