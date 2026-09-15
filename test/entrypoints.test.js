// 交付入口回归：
//  1) 项目路径含空格（及中文）时，npm start 必须持续监听并提供页面，而不是 0 状态秒退；
//     相对路径（npm start 内部 `node server.js`）与绝对路径两种启动方式都验证。
//  2) 标准测试入口（npm test → node --test 自动发现，无目录位置参数）必须完整执行业务用例。
//  3) 标准测试入口连续执行两次都成功（回归间歇性取消：端口由内核分配 + 重型子进程串行隔离）。
//
// 并发说明：node:test 默认并发执行同文件顶层用例；而本文件的用例会派生独立 npm test 子进程，
// 子进程里的 http 用例会启动真实服务。因此：
//   - 服务端口一律传 0 由内核分配，避免父子进程/用例间抢固定端口；
//   - 本文件用 describe(..., { concurrency: 1 }) 串行执行，彻底消除资源竞争窗口；
//   - 子进程以独立进程组启动，结束时向整个进程组发信号并等待退出，杜绝残留服务。
// 子进程通过环境变量跳过本文件，防止递归自调用；同时剔除父运行器的 NODE_TEST_CONTEXT。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (process.env.PF_ENTRY_RECURSION_GUARD === "1") {
  test("入口回归：在嵌套子进程中跳过（防止递归）", () => assert.ok(true));
} else {
  function stageProject() {
    // 路径同时包含空格与中文：回归 file:// URL 百分号编码比较问题
    const base = mkdtempSync(join(tmpdir(), "pf 空格目录 回归-"));
    const project = join(base, "纸坊 项目 副本");
    mkdirSync(project, { recursive: true });
    for (const item of ["package.json", "server.js", "src", "public", "test"]) {
      cpSync(join(root, item), join(project, item), { recursive: true });
    }
    return { base, project };
  }

  function spawnChild(cmd, args, { cwd, env = {} }) {
    const child = spawn(cmd, args, {
      cwd,
      env: (() => {
        const e = { ...process.env, PF_ENTRY_RECURSION_GUARD: "1", ...env };
        delete e.NODE_TEST_CONTEXT; // 否则 Node 20 子运行器判定嵌套运行而跳过全部文件
        return e;
      })(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 独立进程组，便于整组回收
    });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    child.getOutput = () => out;
    return child;
  }

  // 等待整个子进程组退出（npm 外壳与其派生的 node 服务）
  async function killGroup(child) {
    if (child.pid == null) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        resolve(false);
      }, 3000);
      child.on("exit", () => { clearTimeout(timer); resolve(true); });
    });
    // 兜底：再确认进程组已空
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    return exited;
  }

  // 轮询 URL：服务就绪即返回；若进程提前退出则带着输出失败
  async function waitForUrl(child, url, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(`服务进程已退出 code=${child.exitCode} signal=${child.signalCode}\n${child.getOutput()}`);
      }
      try {
        const res = await fetch(url);
        if (res.ok) return res;
        lastErr = new Error("HTTP " + res.status);
      } catch (e) { lastErr = e; }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error("服务未在规定时间内就绪：" + (lastErr?.message || lastErr) + "\n" + child.getOutput());
  }

  // 在临时副本里跑一次完整 npm test，断言退出码、零失败且关键业务用例确实执行
  async function runNestedSuite(tag) {
    const { base, project } = stageProject();
    const child = spawnChild(npm, ["test", "--silent"], { cwd: project });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    const text = child.getOutput();
    rmSync(base, { recursive: true, force: true });
    assert.equal(code, 0, `[${tag}] npm test 退出码 ${code}\n${text}`);
    assert.match(text, /tests\s+\d+/, `[${tag}] 未发现测试执行汇总`);
    assert.match(text, /pass\s+\d+/, `[${tag}] 未发现通过用例汇总`);
    assert.match(text, /fail\s+0\b/, `[${tag}] 存在失败用例\n${text}`);
    assert.match(text, /cancelled\s+0\b/, `[${tag}] 有用例被取消\n${text}`);
    const testsLine = text.match(/tests\s+(\d+)/);
    assert.ok(Number(testsLine[1]) >= 16, `[${tag}] 业务用例未完整执行，仅 ${testsLine[1]} 个\n${text}`);
    for (const name of ["完整走通", "落盘/提交失败整体回滚", "重启后数据仍在", "旧数据兼容", "检测人不能复核自己的试样"]) {
      assert.ok(text.includes(name), `[${tag}] 子进程未执行业务用例：${name}`);
    }
  }

  // concurrency:1 —— 三个重型子进程用例严格串行，互不抢占端口/CPU
  describe("交付入口（含空格路径、标准测试入口）", { concurrency: 1, timeout: 180000 }, () => {
    test("npm start：持续监听且页面/接口可访问（相对路径启动）", async () => {
      const { base, project } = stageProject();
      // 端口传 0，由内核分配后从子进程输出中解析
      const child = spawnChild(npm, ["start", "--silent"], {
        cwd: project,
        env: { PORT: "0", DB_PATH: join(project, "data", "proof.json") },
      });
      try {
        // 读取启动日志里的实际端口（server.js 打印 listening on http://…:PORT）
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("未等到启动日志\n" + child.getOutput())), 15000);
          const tick = setInterval(() => {
            if (child.exitCode !== null) {
              clearInterval(tick); clearTimeout(timer);
              reject(new Error("npm start 提前退出\n" + child.getOutput()));
            }
            const m = child.getOutput().match(/listening on http:\/\/[^:]+:(\d+)/);
            if (m) { clearInterval(tick); clearTimeout(timer); resolve(Number(m[1])); }
          }, 100);
        });
        const res = await waitForUrl(child, `http://127.0.0.1:${port}/api/users`);
        const users = await res.json();
        assert.ok(Array.isArray(users) && users.length >= 4, "用户接口异常");
        const page = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(page.status, 200);
        assert.ok((await page.text()).includes("客户纸样打样确认台"));
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(child.exitCode, null, "npm start 不应自行退出");
      } finally {
        await killGroup(child);
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("以绝对路径执行 node server.js 同样正常监听", async () => {
      const { base, project } = stageProject();
      const child = spawnChild(process.execPath, [join(project, "server.js")], {
        cwd: project,
        env: { PORT: "0", DB_PATH: join(project, "data", "proof2.json") },
      });
      try {
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("未等到启动日志\n" + child.getOutput())), 15000);
          const tick = setInterval(() => {
            if (child.exitCode !== null) {
              clearInterval(tick); clearTimeout(timer);
              reject(new Error("node server.js 提前退出\n" + child.getOutput()));
            }
            const m = child.getOutput().match(/listening on http:\/\/[^:]+:(\d+)/);
            if (m) { clearInterval(tick); clearTimeout(timer); resolve(Number(m[1])); }
          }, 100);
        });
        await waitForUrl(child, `http://127.0.0.1:${port}/api/health`);
        const page = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(page.status, 200);
        assert.equal(child.exitCode, null, "服务不应自行退出");
      } finally {
        await killGroup(child);
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("npm test：标准入口完整执行，0 失败 0 取消（Node 20/22 兼容）", async () => {
      await runNestedSuite("单次");
    });

    test("标准测试入口连续执行两次均成功（回归间歇性取消）", { timeout: 300000 }, async () => {
      await runNestedSuite("第1次");
      await runNestedSuite("第2次");
    });
  });
}
