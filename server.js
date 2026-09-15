// HTTP 入口：路由、会话身份（X-User-Id 头 / x-user-id 调试）、静态页。
// 业务规则全部在 src/service.js；本文件不含领域判断。
import http from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { Store } from "./src/store.js";
import { USERS, HttpError } from "./src/domain.js";
import { makeService } from "./src/service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "data", "paper-proofing.json");
const PORT = Number(process.env.PORT || 3039);

// 判断本文件是否为主入口。
// 必须用 realpath 比较：Node 加载主模块时 import.meta.url 已解析符号链接到真实路径，
// 而 process.argv[1] 保留调用时写的路径（可能是同一目录的别名、相对路径、含空格/中文）。
// 直接字符串比较会在「别名目录绝对路径启动」时失配，导致不监听即 0 退出。
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(self) === realpathSync(resolve(argv1));
  } catch {
    return import.meta.url === pathToFileURL(resolve(argv1)).href;
  }
}

export async function createApp({ dbPath = DB_PATH, failpoint = null, port = PORT } = {}) {
  const store = new Store(dbPath, { failpoint });
  await store.init();
  const svc = makeService(store);
  const indexHtml = await readFile(join(__dirname, "public", "index.html"), "utf8");

  function auth(req) {
    const id = req.headers["x-user-id"];
    if (!id) throw new HttpError(401, "unauthorized", "请先选择登录身份");
    const user = USERS.find((u) => u.id === id);
    if (!user) throw new HttpError(401, "unauthorized", "身份不存在，请重新选择");
    return user;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "bad_json", "请求体不是合法 JSON");
    }
  }

  function send(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;
      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(indexHtml);
      }
      if (req.method === "GET" && p === "/api/health") {
        return send(res, 200, { ok: true, warnings: store.db.migrationWarnings || [] });
      }
      if (req.method === "GET" && p === "/api/users") {
        return send(res, 200, USERS.map(({ id, name, roles, customerId }) => ({ id, name, roles, customerId })));
      }
      if (req.method === "GET" && p === "/api/meta") {
        return send(res, 200, await svc.meta(auth(req)));
      }
      if (req.method === "GET" && p === "/api/orders") {
        const user = auth(req);
        return send(res, 200, await svc.listAndStats(user, {
          customerId: url.searchParams.get("customerId") || "",
          purpose: url.searchParams.get("purpose") || "",
          version: url.searchParams.get("version") || "",
          deviation: url.searchParams.get("deviation") || "",
          confirmStatus: url.searchParams.get("confirm") || "",
          q: url.searchParams.get("q") || "",
        }));
      }

      const orderMatch = p.match(/^\/api\/orders\/([^/]+)(\/([a-z-]+))?$/);
      if (orderMatch) {
        const orderId = decodeURIComponent(orderMatch[1]);
        const action = orderMatch[3] || "";
        const user = auth(req);

        if (req.method === "GET" && action === "") {
          return send(res, 200, await svc.getOrder(user, orderId));
        }
        if (req.method === "GET" && action === "compare") {
          return send(res, 200, await svc.compare(user, orderId, {
            version: url.searchParams.get("av"),
            roundNo: url.searchParams.get("ar"),
          }, {
            version: url.searchParams.get("bv"),
            roundNo: url.searchParams.get("br"),
          }));
        }
        if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "仅支持 POST 写操作");
        const input = await readBody(req);
        let out;
        switch (action) {
          case "":
            out = await svc.editSpec(user, orderId, input); break;
          case "specimens":
            out = await svc.submitSpecimen(user, orderId, input); break;
          case "tests":
            out = await svc.submitTest(user, orderId, input); break;
          case "inspector-reject":
            out = await svc.rejectAsInspector(user, orderId, input); break;
          case "reviews":
            out = await svc.review(user, orderId, input); break;
          case "confirmations":
            out = await svc.customerConfirm(user, orderId, input); break;
          case "revisions":
            out = await svc.newRevision(user, orderId, input); break;
          case "versions":
            out = await svc.newVersion(user, orderId, input); break;
          default:
            throw new HttpError(404, "not_found", "未知操作");
        }
        return send(res, 200, out);
      }

      if (req.method === "POST" && p === "/api/orders") {
        const user = auth(req);
        return send(res, 201, await svc.createOrder(user, await readBody(req)));
      }

      // 仅测试/演示：故障注入开关（不改变业务数据）
      if (req.method === "POST" && p === "/api/_failpoint") {
        const input = await readBody(req);
        store.setFailpoint(input.name ? { name: input.name, once: input.once !== false } : null);
        return send(res, 200, { failpoint: store.failpoint });
      }

      send(res, 404, { error: "not_found", message: "接口不存在" });
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.code, message: err.message, detail: err.detail });
      }
      send(res, 500, { error: "internal", message: err.message });
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  // 允许 port=0：由内核分配空闲端口，避免并发/嵌套测试抢占固定端口
  const actualPort = server.address().port;
  return { server, store, svc, port: actualPort };
}

if (isMainModule()) {
  createApp().then(({ port, store }) => {
    console.log(`纸坊打样确认台 listening on http://localhost:${port}，数据 ${DB_PATH}`);
    for (const w of store.db.migrationWarnings || []) console.log("迁移提示：" + w);
  }).catch((err) => { console.error(err); process.exit(1); });
}