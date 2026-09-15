// HTTP 端到端：真实服务器 + fetch，验证状态码、身份头、并发 409、筛选参数、故障注入、跨重启
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "pf-http-"));
  const dbPath = join(dir, "db.json");
  const app = await createApp({ dbPath, port: 0 });
  const users = await (await fetch(`http://127.0.0.1:${app.port}/api/users`)).json();
  const uid = Object.fromEntries(users.map((u) => [u.name, u.id]));
  const h2 = {
    dir, app, base: `http://127.0.0.1:${app.port}`, uid,
    api: async (method, path, user, body) => {
      const res = await fetch(h2.base + path, {
        method,
        headers: { "Content-Type": "application/json", ...(user ? { "X-User-Id": user } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    },
    async stop() {
      await new Promise((r) => {
        h2.app.server.closeAllConnections();
        h2.app.server.close(r);
      });
      await rm(dir, { recursive: true, force: true });
    },
    async restart() {
      await new Promise((r) => {
        app.server.closeAllConnections();
        app.server.close(r);
      });
      const app2 = await createApp({ dbPath, port: 0 });
      h2.app = app2;
      h2.base = `http://127.0.0.1:${app2.port}`;
      return h2.base;
    },
  };
  return h2;
}

const spec = {
  customerId: "cus-jinfeng", purpose: "线装书封面",
  length: 297, width: 210, thickness: 120, texture: "棉料细纹理", deltaE: 1.5,
};
const pass = { length: 297.5, width: 210.8, thickness: 122, texture: "棉料细纹理", deltaE: 1.0 };

test("HTTP：未登录 401；全流程切换身份走通并 2xx", async () => {
  const h = await boot();
  try {
    assert.equal((await fetch(h.base + "/api/orders")).status, 401);
    let r = await h.api("POST", "/api/orders", h.uid["沈师傅"], spec);
    assert.equal(r.status, 201);
    const id = r.json.id;
    const rev = r.json.revision;

    // 送样员检测 → 403
    r = await h.api("POST", `/api/orders/${id}/tests`, h.uid["沈师傅"], { values: pass });
    assert.equal(r.status, 403);

    r = await h.api("POST", `/api/orders/${id}/specimens`, h.uid["沈师傅"], { expectedRevision: rev });
    assert.equal(r.status, 200);
    const rev2 = r.json.revision;

    // 缺项 → 422
    r = await h.api("POST", `/api/orders/${id}/tests`, h.uid["严检"], { values: { length: 297 } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error, "missing_fields");

    // 超差 → 422
    r = await h.api("POST", `/api/orders/${id}/tests`, h.uid["严检"], { values: { ...pass, length: 301 } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error, "out_of_tolerance");

    // 重复并发送检：一个 200 已发生；此处两个并发检测同 revision 都会被串行处理，
    // 先到者成功、后到者因状态推进（越序）拒绝
    const rs = await Promise.all([
      h.api("POST", `/api/orders/${id}/tests`, h.uid["严检"], { expectedRevision: rev2, values: pass }),
      h.api("POST", `/api/orders/${id}/tests`, h.uid["策检"], { expectedRevision: rev2, values: pass }),
    ]);
    const codes = rs.map((x) => x.status).sort();
    assert.equal(codes[0], 200);
    assert.ok([409, 422].includes(codes[1]), `第二次并发提交应被拒绝，实际 ${codes[1]}`);
    const rejected = rs.find((x) => x.status !== 200);
    assert.ok(["stale_write", "out_of_order"].includes(rejected.json.error));

    const tested = await h.api("GET", `/api/orders/${id}`, h.uid["沈师傅"]);
    const rev3 = tested.json.revision;

    // 检测人自复核 → 403
    r = await h.api("POST", `/api/orders/${id}/reviews`, h.uid["严检"], { expectedRevision: rev3, decision: "approve" });
    assert.equal(r.status, 403);
    // 季双有复核角色但她没测这单 → 通过
    r = await h.api("POST", `/api/orders/${id}/reviews`, h.uid["季双"], { expectedRevision: rev3, decision: "approve" });
    assert.equal(r.status, 200);
    const rev4 = r.json.revision;

    // 别家客户确认 → 403
    r = await h.api("POST", `/api/orders/${id}/confirmations`, h.uid["云墨书院·李先生"], { decision: "approve" });
    assert.equal(r.status, 403);

    r = await h.api("POST", `/api/orders/${id}/confirmations`, h.uid["锦封文创·苏掌柜"], { expectedRevision: rev4, decision: "approve" });
    assert.equal(r.status, 200);

    // 锁定后送检 → 423
    r = await h.api("POST", `/api/orders/${id}/specimens`, h.uid["沈师傅"], {});
    assert.equal(r.status, 423);
    // 过期 revision 新版本 → 409
    r = await h.api("POST", `/api/orders/${id}/versions`, h.uid["沈师傅"], { expectedRevision: rev4, length: 300 });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "stale_write");

    const final = await h.api("GET", `/api/orders/${id}`, h.uid["沈师傅"]);
    r = await h.api("POST", `/api/orders/${id}/versions`, h.uid["沈师傅"], { expectedRevision: final.json.revision, length: 300 });
    assert.equal(r.status, 200);
    assert.equal(r.json.specVersion, 2);
  } finally {
    await h.stop();
  }
});

test("HTTP：筛选参数生效，统计与明细一致", async () => {
  const h = await boot();
  try {
    const r = await h.api("POST", "/api/orders", h.uid["沈师傅"], spec);
    const id = r.json.id, rev = r.json.revision;
    await h.api("POST", `/api/orders/${id}/specimens`, h.uid["沈师傅"], { expectedRevision: rev });
    let x = await h.api("POST", `/api/orders/${id}/tests`, h.uid["严检"], { values: pass });
    x = await h.api("POST", `/api/orders/${id}/reviews`, h.uid["傅核"], { expectedRevision: x.json.revision, decision: "approve" });
    await h.api("POST", `/api/orders/${id}/confirmations`, h.uid["锦封文创·苏掌柜"], { expectedRevision: x.json.revision, decision: "approve" });
    await h.api("POST", "/api/orders", h.uid["沈师傅"], { ...spec, purpose: "书签便签" });

    const q = (qs, user) => h.api("GET", "/api/orders?" + qs, user);
    let r2 = await q("version=all&confirm=confirmed", h.uid["沈师傅"]);
    assert.equal(r2.json.stats.confirmed, 1);
    assert.equal(r2.json.stats.total, r2.json.rows.length);
    assert.ok(r2.json.rows.every((row) => row.confirmed));

    r2 = await q("customerId=cus-jinfeng&version=all", h.uid["沈师傅"]);
    assert.ok(r2.json.rows.every((row) => row.customerId === "cus-jinfeng"));

    r2 = await q("deviation=untested&version=all", h.uid["沈师傅"]);
    assert.ok(r2.json.rows.some((row) => row.purpose === "书签便签"));

    // 客户身份自动隔离：云墨看不到锦封的单
    r2 = await q("version=all", h.uid["云墨书院·李先生"]);
    assert.equal(r2.json.stats.total, 0);
  } finally {
    await h.stop();
  }
});

test("HTTP：故障注入导致失败后回滚，跨重启数据仍在", async () => {
  const h = await boot();
  try {
    let r = await h.api("POST", "/api/orders", h.uid["沈师傅"], spec);
    const id = r.json.id, rev = r.json.revision;

    await h.api("POST", "/api/_failpoint", null, { name: "afterTmpWrite", once: true });
    r = await h.api("POST", `/api/orders/${id}/specimens`, h.uid["沈师傅"], { expectedRevision: rev });
    assert.equal(r.status, 500);

    r = await h.api("GET", `/api/orders/${id}`, h.uid["沈师傅"]);
    assert.equal(r.json.rounds[0].status, "待送样");

    // 重启后仍是待送样（磁盘也回滚）
    const base2 = await h.restart();
    const res = await fetch(base2 + `/api/orders/${id}`, { headers: { "X-User-Id": h.uid["沈师傅"] } });
    const json = await res.json();
    assert.equal(json.rounds[0].status, "待送样");

    // 恢复后继续走完
    let x = await h.api("POST", `/api/orders/${id}/specimens`, h.uid["沈师傅"], { expectedRevision: rev });
    assert.equal(x.status, 200);
  } finally {
    await h.stop();
  }
});

test("HTTP：首页 HTML 可返回", async () => {
  const h = await boot();
  try {
    const res = await fetch(h.base + "/");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("客户纸样打样确认台"));
  } finally {
    await h.stop();
  }
});
