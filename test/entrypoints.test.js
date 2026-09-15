// 交付入口回归：
//  1) 项目路径含空格（及中文）时，npm start 必须持续监听并提供页面，而不是 0 状态秒退；
//     相对路径（npm start 内部 `node server.js`）与绝对路径两种启动方式都验证。
//  2) 标准测试入口（npm test → node --test 自动发现，无目录位置参数）必须完整执行业务用例；
//     同一入口在 Node 20/22 下均成立。
// 子进程内通过环境变量跳过本文件，防止递归自调用。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

if (process.env.PF_ENTRY_RECURSION_GUARD === "1") {
  test("入口回归：在嵌套子进程中跳过（防止递归）", () => assert.ok(true));
} else {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  function stageProject() {
    const base = mkdtempSync(join(tmpdir(), "pf 空格目录 回归-"));
    const project = join(base, "纸坊 项目 副本");
    mkdirSync(project, { recursive: true });
    for (const item of ["package.json", "server.js", "src", "public", "test"]) {
      cpSync(join(root, item), join(project, item), { recursive: true });
    }
    return { base, project };
  }

  function childEnv(extra) {
    const env = { ...process.env, PF_ENTRY_RECURSION_GUARD: "1", ...extra };
    // 关键：剔除父测试运行器的上下文标记，否则 Node 20 的 node:test 认为嵌套运行而跳过全部文件
    delete env.NODE_TEST_CONTEXT;
    return env;
  }

  function spawnChild(cmd, args, { cwd, env = {} }) {
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    child.getOutput = () => out;
    return child;
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
      await new Promise((r) => setTimeout(r, 150));
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    throw new Error("服务未在规定时间内就绪：" + (lastErr?.message || lastErr) + "\n" + child.getOutput());
  }

  async function killGroup(child) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await new Promise((r) => child.on("exit", r)).catch(() => {});
  }

  test("含空格路径下 npm start：持续监听且页面/接口可访问（相对路径启动）", async () => {
    const { base, project } = stageProject();
    const port = 44101;
    const child = spawnChild(npm, ["start", "--silent"], {
      cwd: project,
      env: { PORT: String(port), DB_PATH: join(project, "data", "proof.json") },
    });
    try {
      const res = await waitForUrl(child, `http://127.0.0.1:${port}/api/users`);
      const users = await res.json();
      assert.ok(Array.isArray(users) && users.length >= 4, "用户接口异常");
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes("客户纸样打样确认台"));
      // 多等一拍，确认不是「监听后立刻退出」
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(child.exitCode, null, "npm start 不应自行退出");
    } finally {
      await killGroup(child);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("含空格路径下以绝对路径执行 node server.js 同样正常监听", async () => {
    const { base, project } = stageProject();
    const port = 44102;
    const child = spawnChild(process.execPath, [join(project, "server.js")], {
      cwd: project,
      env: { PORT: String(port), DB_PATH: join(project, "data", "proof2.json") },
    });
    try {
      await waitForUrl(child, `http://127.0.0.1:${port}/api/health`);
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.equal(child.exitCode, null, "服务不应自行退出");
    } finally {
      await killGroup(child);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("含空格路径下 npm test：标准入口完整执行，0 失败（Node 20/22 兼容）", async () => {
    const { base, project } = stageProject();
    const child = spawnChild(npm, ["test", "--silent"], { cwd: project });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    const text = child.getOutput();
    try {
      assert.equal(code, 0, `npm test 退出码 ${code}\n${text}`);
      // 不同 reporter 前缀不同：tap 用 "#"，spec 管道下用 "ℹ"
      assert.match(text, /tests\s+\d+/, "未发现测试执行汇总");
      assert.match(text, /pass\s+\d+/, "未发现通过用例汇总");
      assert.match(text, /fail\s+0\b/, "存在失败用例");
      const testsLine = text.match(/tests\s+(\d+)/);
      assert.ok(Number(testsLine[1]) >= 16, `业务用例未完整执行，仅 ${testsLine[1]} 个`);
      // 关键业务用例确实被发现并执行，而非空跑
      for (const name of ["完整走通", "落盘/提交失败整体回滚", "重启后数据仍在", "旧数据兼容", "检测人不能复核自己的试样"]) {
        assert.ok(text.includes(name), `子进程未执行业务用例：${name}`);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
