// 业务服务层：所有状态流转、权限、完整性/公差校验、乐观锁、统计口径集中于此。
// HTTP 层只做鉴权取用户与参数解析；测试也直接调用这里。
import {
  HttpError, ROUND_STATUS, TEXTURES, NUMERIC_ITEMS, ALL_ITEMS, ITEM_LABELS,
  DEFAULT_TOLERANCE, deviationRatio, deviationGrade, orderStatus,
  snapshotFromRound, genOrderCode,
} from "./domain.js";

const now = () => new Date().toISOString();
const num = (v) => (v === "" || v == null ? NaN : Number(v));

function requireRole(user, role) {
  if (!user.roles.includes(role)) {
    throw new HttpError(403, "forbidden", `当前身份「${user.name}」无权执行此操作（需要${role}）`);
  }
}

function findOrder(db, orderId) {
  const order = db.orders.find((o) => o.id === orderId || o.code === orderId);
  if (!order) throw new HttpError(404, "order_not_found", "打样单不存在");
  return order;
}

function scopeOrder(user, order) {
  if (user.roles.includes("customer") && user.customerId !== order.customerId) {
    throw new HttpError(403, "forbidden", "客户只能查看本客户的打样单");
  }
}

function latestRound(order) {
  return order.rounds[order.rounds.length - 1];
}

// 校验乐观锁（过期写入拒绝）
function checkRevision(order, expectedRevision) {
  if (expectedRevision != null && Number(expectedRevision) !== order.revision) {
    throw new HttpError(
      409,
      "stale_write",
      `数据已被他人更新（服务器版本 ${order.revision}，提交基于 ${expectedRevision}），请刷新后重试`,
    );
  }
}

function assertStatus(round, allowed) {
  if (!allowed.includes(round.status)) {
    throw new HttpError(
      422,
      "out_of_order",
      `越序操作：轮次当前为「${round.status}」，允许该操作的状态为「${allowed.join(" / ")}」`,
    );
  }
}

function appendEvent(order, user, type, detail = {}) {
  order.events.push({ seq: order.events.length + 1, at: now(), actorId: user.id, actorName: user.name, type, detail });
}

// ---- 规格校验 ----
function validateSpec(input, { partial = false } = {}) {
  const spec = {};
  const errors = [];
  for (const key of ["length", "width", "thickness", "deltaE"]) {
    if (input[key] == null || input[key] === "") {
      if (!partial) errors.push(`${ITEM_LABELS[key]}未填写`);
      continue;
    }
    const n = num(input[key]);
    if (!Number.isFinite(n) || n <= 0) errors.push(`${ITEM_LABELS[key]}必须为正数`);
    else spec[key] = n;
  }
  if (input.texture != null && input.texture !== "") {
    if (!TEXTURES.includes(input.texture)) errors.push(`纹理必须是：${TEXTURES.join("、")}`);
    else spec.texture = input.texture;
  } else if (!partial) errors.push("纹理未选择");

  const tol = {};
  const tolInput = input.tolerance || {};
  for (const key of NUMERIC_ITEMS) {
    if (tolInput[key] == null || tolInput[key] === "") continue;
    const t = num(tolInput[key]);
    if (!Number.isFinite(t) || t <= 0) errors.push(`${ITEM_LABELS[key]}公差必须为正数`);
    else tol[key] = t;
  }
  return { spec, tolerance: tol, errors };
}

function mergeSpec(base, patch) {
  const out = JSON.parse(JSON.stringify(base));
  Object.assign(out, patch.spec);
  out.tolerance = { ...(out.tolerance || {}), ...patch.tolerance };
  return out;
}

function newRound(specVersion, roundNo, spec) {
  return {
    id: `r-v${specVersion}-${roundNo}`,
    specVersion,
    roundNo,
    status: ROUND_STATUS.DRAFT,
    spec: JSON.parse(JSON.stringify(spec)),
    specimen: null,
    test: null,
    review: null,
    confirmation: null,
    rejection: null,
    revision: 0,
    createdAt: now(),
  };
}

// ---- 检测值完整性与公差 ----
function readValues(input) {
  const raw = input.values || {};
  const values = {};
  const missing = [];
  for (const key of NUMERIC_ITEMS) {
    const n = num(raw[key]);
    if (raw[key] == null || raw[key] === "" || !Number.isFinite(n)) missing.push(ITEM_LABELS[key]);
    else values[key] = n;
  }
  if (raw.texture == null || String(raw.texture).trim() === "") missing.push(ITEM_LABELS.texture);
  else {
    if (!TEXTURES.includes(raw.texture)) {
      throw new HttpError(422, "invalid_value", `纹理必须是：${TEXTURES.join("、")}`);
    }
    values.texture = raw.texture;
  }
  return { values, missing };
}

function evaluateTest(round, values) {
  const over = [];
  for (const key of NUMERIC_ITEMS) {
    const target = round.spec[key];
    const tol = round.spec.tolerance?.[key] ?? DEFAULT_TOLERANCE[key];
    const v = values[key];
    if (target == null || v == null) continue;
    const excess = key === "deltaE" ? v - target : Math.abs(v - target);
    if (excess > tol + 1e-9) {
      over.push({ item: key, label: ITEM_LABELS[key], target, actual: v, tolerance: tol, excess: Number(excess.toFixed(4)) });
    }
  }
  // 纹理必须与登记一致（枚举匹配）
  let textureMismatch = false;
  if (values.texture && round.spec.texture && values.texture !== round.spec.texture) textureMismatch = true;
  return { over, textureMismatch };
}

// ============================== 操作 ==============================

export function createOrder(svc, user, input) {
  requireRole(user, "submitter");
  const customerId = String(input.customerId || "").trim();
  const purpose = String(input.purpose || "").trim();
  if (!customerId) throw new HttpError(422, "missing_fields", "客户未选择");
  if (!purpose) throw new HttpError(422, "missing_fields", "用途未填写");

  return svc.store.mutate((db) => {
    if (!db.customers.some((c) => c.id === customerId)) throw new HttpError(422, "invalid_value", "客户不存在");
    const { spec, tolerance, errors } = validateSpec(input);
    if (errors.length) throw new HttpError(422, "missing_fields", errors.join("；"));
    spec.tolerance = { ...DEFAULT_TOLERANCE, ...tolerance };

    db.seq += 1;
    const order = {
      id: `o-${db.seq}`,
      code: genOrderCode(db.seq),
      customerId,
      purpose,
      specVersion: 1,
      note: String(input.note || ""),
      createdAt: now(),
      revision: 1,
      rounds: [],
      versions: [],
      events: [],
    };
    order.rounds.push(newRound(1, 1, spec));
    appendEvent(order, user, "建档", { code: order.code, customerId, purpose });
    db.orders.unshift(order);
    return viewOrder(order, user);
  }, { label: "createOrder" });
}

export function editSpec(svc, user, orderId, input = {}) {
  requireRole(user, "submitter");
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    checkRevision(order, input.expectedRevision);
    const round = latestRound(order);
    if (round.status === ROUND_STATUS.CONFIRMED) {
      throw new HttpError(423, "locked_version", "客户已确认并锁定该版本；修改请新建版本");
    }
    assertStatus(round, [ROUND_STATUS.DRAFT]);
    const { spec, tolerance, errors } = validateSpec(input, { partial: true });
    if (input.purpose != null) {
      const p = String(input.purpose).trim();
      if (!p) throw new HttpError(422, "missing_fields", "用途不能为空");
      order.purpose = p;
    }
    if (errors.length) throw new HttpError(422, "invalid_value", errors.join("；"));
    if (Object.keys(spec).length || Object.keys(tolerance).length) {
      round.spec = mergeSpec(round.spec, { spec, tolerance });
    }
    order.revision += 1;
    round.revision += 1;
    appendEvent(order, user, "编辑", { roundNo: round.roundNo });
    return viewOrder(order, user);
  }, { label: "editSpec" });
}

export function submitSpecimen(svc, user, orderId, input = {}) {
  requireRole(user, "submitter");
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    checkRevision(order, input.expectedRevision);
    const round = latestRound(order);
    if (round.status === ROUND_STATUS.CONFIRMED) throw new HttpError(423, "locked_version", "版本已锁定，不能再送检");
    // 同一打样单只能保留一个待检试样：非待送样状态一律拒绝（越序/重复）
    assertStatus(round, [ROUND_STATUS.DRAFT]);
    round.specimen = {
      submittedById: user.id,
      submittedByName: user.name,
      submittedAt: now(),
      note: String(input.note || ""),
    };
    round.status = ROUND_STATUS.PENDING_TEST;
    order.revision += 1;
    round.revision += 1;
    appendEvent(order, user, "送样", { roundNo: round.roundNo });
    return viewOrder(order, user);
  }, { label: "submitSpecimen" });
}

// 检测登记：缺项 / 超差 / 越序 / 重复提交一律拒绝
export function submitTest(svc, user, orderId, input = {}) {
  requireRole(user, "inspector");
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    checkRevision(order, input.expectedRevision);
    const round = latestRound(order);
    assertStatus(round, [ROUND_STATUS.PENDING_TEST]); // 越序拒绝
    if (round.test) {
      throw new HttpError(409, "duplicate_submit", "该试样已登记过完整检测值，不能重复提交");
    }
    const { values, missing } = readValues(input);
    if (missing.length) throw new HttpError(422, "missing_fields", `检测值缺项：${missing.join("、")}`);
    const { over, textureMismatch } = evaluateTest(round, values);
    if (over.length || textureMismatch) {
      const detail = over.map((d) => `${d.label}实测${d.actual}超出公差（目标${d.target}±${d.tolerance}）`);
      if (textureMismatch) detail.push(`纹理「${values.texture}」与登记纹理「${round.spec.texture}」不符`);
      throw new HttpError(422, "out_of_tolerance", "检测超差，提交被拒绝：" + detail.join("；"), { over, textureMismatch });
    }
    round.test = {
      values,
      inspectorId: user.id,
      inspectorName: user.name,
      testedAt: now(),
    };
    round.status = ROUND_STATUS.PENDING_REVIEW;
    order.revision += 1;
    round.revision += 1;
    appendEvent(order, user, "检测", { roundNo: round.roundNo });
    return viewOrder(order, user);
  }, { label: "submitTest" });
}

// 检测现场判定试样超差：必须带完整检测值，且至少一项确实超差；本轮驳回，之后只能新建修订轮
export function rejectAsInspector(svc, user, orderId, input = {}) {
  requireRole(user, "inspector");
  const reason = String(input.reason || "").trim();
  if (!reason) throw new HttpError(422, "missing_fields", "判废必须填写原因");
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    checkRevision(order, input.expectedRevision);
    const round = latestRound(order);
    assertStatus(round, [ROUND_STATUS.PENDING_TEST]);
    const { values, missing } = readValues(input);
    if (missing.length) throw new HttpError(422, "missing_fields", `检测值缺项：${missing.join("、")}`);
    const { over, textureMismatch } = evaluateTest(round, values);
    if (!over.length && !textureMismatch) {
      throw new HttpError(422, "not_out_of_tolerance", "检测值均在公差内，不能判废；请正常提交检测");
    }
    round.test = { values, inspectorId: user.id, inspectorName: user.name, testedAt: now(), failed: true };
    round.status = ROUND_STATUS.REJECTED;
    round.rejection = { at: now(), byId: user.id, byName: user.name, stage: "检测", reason, over, textureMismatch };
    order.revision += 1;
    round.revision += 1;
    appendEvent(order, user, "检测判废", { roundNo: round.roundNo, reason });
    return viewOrder(order, user);
  }, { label: "rejectAsInspector" });
}

// 复核：检测人不能复核自己的试样；通过则转客户确认，驳回则本轮终止
export function review(svc, user, orderId, input = {}) {
  requireRole(user, "reviewer");
  const decision = input.decision === "approve" ? "approve" : input.decision === "reject" ? "reject" : null;
  if (!decision) throw new HttpError(422, "missing_fields", "复核结论必须是 approve 或 reject");
  if (decision === "reject" && !String(input.reason || "").trim()) {
    throw new HttpError(422, "missing_fields", "驳回必须填写原因");
  }
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    checkRevision(order, input.expectedRevision);
    const round = latestRound(order);
    assertStatus(round, [ROUND_STATUS.PENDING_REVIEW]);
    if (round.test.inspectorId === user.id) {
      throw new HttpError(403, "self_review_forbidden", "检测人不能复核自己的试样，请由其他复核员处理");
    }
    if (decision === "approve") {
      round.review = { reviewerId: user.id, reviewerName: user.name, reviewedAt: now(), result: "通过" };
      round.status = ROUND_STATUS.PENDING_CONFIRM;
      appendEvent(order, user, "复核通过", { roundNo: round.roundNo });
    } else {
      round.review = { reviewerId: user.id, reviewerName: user.name, reviewedAt: now(), result: "驳回" };
      round.status = ROUND_STATUS.REJECTED;
      round.rejection = {
        at: now(), byId: user.id, byName: user.name, stage: "复核",
        reason: String(input.reason).trim(),
      };
      appendEvent(order, user, "复核驳回", { roundNo: round.roundNo, reason: input.reason });
    }
    order.revision += 1;
    round.revision += 1;
    return viewOrder(order, user);
  }, { label: "review" });
}

// 客户确认：锁定版本；客户也可驳回（必须给原因）→ 新建修订轮
export function customerConfirm(svc, user, orderId, input = {}) {
  requireRole(user, "customer");
  const reject = input.decision === "reject";
  if (reject && !String(input.reason || "").trim()) {
    throw new HttpError(422, "missing_fields", "客户驳回必须填写原因");
  }
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    if (user.customerId !== order.customerId) throw new HttpError(403, "forbidden", "只能确认本客户的打样单");
    checkRevision(order, input.expectedRevision);
    const round = latestRound(order);
    assertStatus(round, [ROUND_STATUS.PENDING_CONFIRM]);
    if (reject) {
      round.status = ROUND_STATUS.REJECTED;
      round.confirmation = { customerId: user.customerId, decidedById: user.id, decidedByName: user.name, decidedAt: now(), result: "驳回" };
      round.rejection = {
        at: now(), byId: user.id, byName: user.name, stage: "客户确认",
        reason: String(input.reason).trim(),
      };
      appendEvent(order, user, "客户驳回", { roundNo: round.roundNo, reason: input.reason });
    } else {
      round.status = ROUND_STATUS.CONFIRMED;
      round.confirmation = {
        customerId: user.customerId,
        decidedById: user.id,
        decidedByName: user.name,
        decidedAt: now(),
        result: "确认",
      };
      appendEvent(order, user, "客户确认", { roundNo: round.roundNo, specVersion: order.specVersion });
    }
    order.revision += 1;
    round.revision += 1;
    return viewOrder(order, user);
  }, { label: "customerConfirm" });
}

// 驳回后新建修订轮：旧轮只读保留，规格可在登记范围内修订
export function newRevision(svc, user, orderId, input = {}) {
  requireRole(user, "submitter");
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    checkRevision(order, input.expectedRevision);
    const last = latestRound(order);
    assertStatus(last, [ROUND_STATUS.REJECTED]);
    const prev = last.spec;
    const { spec, tolerance, errors } = validateSpec(input, { partial: true });
    if (errors.length) throw new HttpError(422, "invalid_value", errors.join("；"));
    const merged = (Object.keys(spec).length || Object.keys(tolerance).length)
      ? mergeSpec(prev, { spec, tolerance })
      : JSON.parse(JSON.stringify(prev));
    const round = newRound(order.specVersion, last.roundNo + 1, merged);
    round.createdFrom = last.roundNo;
    order.rounds.push(round);
    order.revision += 1;
    appendEvent(order, user, "修订", { fromRound: last.roundNo, toRound: round.roundNo });
    return viewOrder(order, user);
  }, { label: "newRevision" });
}

// 客户确认锁定后再修改：生成新版本；旧版本整体归档只读
export function newVersion(svc, user, orderId, input = {}) {
  requireRole(user, "submitter");
  return svc.store.mutate((db) => {
    const order = findOrder(db, orderId);
    checkRevision(order, input.expectedRevision);
    const last = latestRound(order);
    assertStatus(last, [ROUND_STATUS.CONFIRMED]);

    const { spec, tolerance, errors } = validateSpec(input, { partial: true });
    if (input.purpose != null) {
      const p = String(input.purpose).trim();
      if (!p) throw new HttpError(422, "missing_fields", "用途不能为空");
      order.purpose = p;
    }
    if (errors.length) throw new HttpError(422, "invalid_value", errors.join("；"));

    // 归档当前版本（旧记录只读快照）
    order.versions.push({
      specVersion: order.specVersion,
      purpose: order.purpose,
      rounds: JSON.parse(JSON.stringify(order.rounds)),
      confirmedAt: now(),
    });
    const base = JSON.parse(JSON.stringify(last.spec));
    const merged = (Object.keys(spec).length || Object.keys(tolerance).length)
      ? mergeSpec(base, { spec, tolerance })
      : base;
    order.specVersion += 1;
    order.rounds = [newRound(order.specVersion, 1, merged)];
    order.revision += 1;
    appendEvent(order, user, "新版本", { specVersion: order.specVersion });
    return viewOrder(order, user);
  }, { label: "newVersion" });
}

// ============================== 查询 / 视图 ==============================

function viewRound(round) {
  const ratio = deviationRatio(round);
  return {
    ...round,
    deviationRatio: ratio == null ? null : Number(ratio.toFixed(4)),
    grade: deviationGrade(round),
    locked: round.status === ROUND_STATUS.CONFIRMED,
  };
}

function viewOrder(order, user = null) {
  if (user) scopeOrder(user, order);
  return {
    id: order.id,
    code: order.code,
    customerId: order.customerId,
    purpose: order.purpose,
    note: order.note,
    specVersion: order.specVersion,
    status: orderStatus(order),
    revision: order.revision,
    createdAt: order.createdAt,
    rounds: order.rounds.map(viewRound),
    versions: order.versions.map((v) => ({
      specVersion: v.specVersion,
      purpose: v.purpose,
      confirmedAt: v.confirmedAt,
      rounds: v.rounds.map(viewRound),
    })),
    events: order.events,
  };
}

export function getOrder(svc, user, orderId) {
  return svc.store.read((db) => viewOrder(findOrder(db, orderId), user));
}

function allRoundRows(db) {
  const customerName = (id) => db.customers.find((c) => c.id === id)?.name || id;
  const rows = [];
  for (const order of db.orders) {
    const pushRounds = (rounds, isCurrent) => {
      for (const r of rounds) {
        const v = viewRound(r);
        rows.push({
          orderId: order.id,
          code: order.code,
          customerId: order.customerId,
          customerName: customerName(order.customerId),
          purpose: isCurrent ? order.purpose : (order.versions.find((x) => x.specVersion === r.specVersion)?.purpose || order.purpose),
          specVersion: r.specVersion,
          isCurrentVersion: isCurrent,
          roundNo: r.roundNo,
          status: r.status,
          grade: v.grade,
          deviationRatio: v.deviationRatio,
          confirmed: r.status === ROUND_STATUS.CONFIRMED,
          orderRevision: order.revision,
        });
      }
    };
    for (const v of order.versions) pushRounds(v.rounds, false);
    pushRounds(order.rounds, true);
  }
  return rows;
}

export function listRows(svc, user, filters = {}) {
  return svc.store.read((db) => {
    let rows = allRoundRows(db);
    // 客户数据隔离
    if (user.roles.includes("customer")) rows = rows.filter((r) => r.customerId === user.customerId);
    if (filters.customerId) rows = rows.filter((r) => r.customerId === filters.customerId);
    if (filters.purpose) rows = rows.filter((r) => r.purpose === filters.purpose);
    if (filters.version === "latest") rows = rows.filter((r) => r.isCurrentVersion);
    else if (filters.version && filters.version !== "all") rows = rows.filter((r) => String(r.specVersion) === String(filters.version));
    if (filters.deviation && filters.deviation !== "all") rows = rows.filter((r) => r.grade === filters.deviation);
    if (filters.confirmStatus === "confirmed") rows = rows.filter((r) => r.confirmed);
    else if (filters.confirmStatus === "unconfirmed") rows = rows.filter((r) => !r.confirmed);
    if (filters.q) {
      const q = filters.q.trim().toLowerCase();
      rows = rows.filter((r) => `${r.code} ${r.purpose} ${r.customerName}`.toLowerCase().includes(q));
    }
    return rows;
  });
}

// 统计与明细同一数据源、同一过滤管线
export async function listAndStats(svc, user, filters = {}) {
  const rows = await listRows(svc, user, filters);
  const stats = {
    total: rows.length,
    confirmed: rows.filter((r) => r.confirmed).length,
    unconfirmed: rows.length - rows.filter((r) => r.confirmed).length,
    byStatus: {},
    byGrade: { within_half: 0, within: 0, out: 0, untested: 0 },
  };
  for (const r of rows) {
    stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1;
    stats.byGrade[r.grade] = (stats.byGrade[r.grade] || 0) + 1;
  }
  return { rows, stats };
}

export function meta(svc, user) {
  return svc.store.read((db) => {
    const purposes = [...new Set(allRoundRows(db).map((r) => r.purpose))].sort();
    const versions = [...new Set(allRoundRows(db).map((r) => r.specVersion))].sort((a, b) => a - b);
    let customers = db.customers;
    if (user.roles.includes("customer")) customers = customers.filter((c) => c.id === user.customerId);
    return {
      customers,
      purposes,
      versions,
      textures: TEXTURES,
      defaultTolerance: DEFAULT_TOLERANCE,
      itemLabels: ITEM_LABELS,
      numericItems: NUMERIC_ITEMS,
      allItems: ALL_ITEMS,
    };
  });
}

function resolveRound(db, order, version, roundNo) {
  const v = Number(version);
  const n = Number(roundNo);
  if (v === order.specVersion) {
    const r = order.rounds.find((x) => x.roundNo === n);
    if (r) return { round: r, purpose: order.purpose };
  }
  const arch = order.versions.find((x) => x.specVersion === v);
  const r = arch?.rounds.find((x) => x.roundNo === n);
  if (r) return { round: r, purpose: arch.purpose, archived: true };
  return null;
}

// 并排比较：任意两个版本/轮次（旧记录只读）
export function compare(svc, user, orderId, a, b) {
  return svc.store.read((db) => {
    const order = findOrder(db, orderId);
    scopeOrder(user, order);
    const ra = resolveRound(db, order, a.version, a.roundNo);
    const rb = resolveRound(db, order, b.version, b.roundNo);
    if (!ra || !rb) throw new HttpError(404, "round_not_found", "要比较的轮次不存在");
    const fmt = (hit, purpose, archived) => ({
      purpose,
      specVersion: hit.specVersion,
      roundNo: hit.roundNo,
      status: hit.status,
      archived: !!archived,
      spec: hit.spec,
      specimen: hit.specimen,
      test: hit.test,
      review: hit.review,
      rejection: hit.rejection,
      confirmation: hit.confirmation,
      deviationRatio: viewRound(hit).deviationRatio,
      grade: viewRound(hit).grade,
    });
    return {
      orderId: order.id,
      code: order.code,
      customerId: order.customerId,
      a: fmt(ra.round, ra.purpose, ra.archived),
      b: fmt(rb.round, rb.purpose, rb.archived),
    };
  });
}

// 统一把服务方法包成 Promise：角色/参数校验即使同步抛出，也以 reject 形式返回
function asyncify(fn) {
  return (...args) => new Promise((resolve, reject) => {
    try { resolve(fn(...args)); } catch (err) { reject(err); }
  });
}

export function makeService(store) {
  const wrap = (fn) => asyncify((user, id, input) => fn({ store }, user, id, input));
  return {
    store,
    createOrder: asyncify((user, input) => createOrder({ store }, user, input)),
    editSpec: wrap(editSpec),
    submitSpecimen: wrap(submitSpecimen),
    submitTest: wrap(submitTest),
    rejectAsInspector: wrap(rejectAsInspector),
    review: wrap(review),
    customerConfirm: wrap(customerConfirm),
    newRevision: wrap(newRevision),
    newVersion: wrap(newVersion),
    getOrder: asyncify((user, id) => getOrder({ store }, user, id)),
    listAndStats: asyncify((user, f) => listAndStats({ store }, user, f)),
    meta: asyncify((user) => meta({ store }, user)),
    compare: asyncify((user, id, a, b) => compare({ store }, user, id, a, b)),
  };
}
