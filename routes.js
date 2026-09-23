"use strict";

// 全部 HTTP 路由：指纹核验规则见 lib/fingerprintRules，核验记录见 lib/verificationRecords。
// handle(req, res, ctx) 由 server.js 注入 db 读写能力与通用工具，保持本文件只处理请求编排。

const {
  normalizeFingerprint,
  isWellFormedFingerprint,
  freezeBeforeFingerprints,
  validateCompletionFingerprints
} = require("./lib/fingerprintRules");
const verification = require("./lib/verificationRecords");

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    verificationRecords: verification.listForBatch(db, batch.id),
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

async function handle(req, res, ctx) {
  const { db, writeDb, send, parseBody, makeId, required } = ctx;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    let beforeFingerprint = "";
    if (body.beforeFingerprint !== undefined) {
      beforeFingerprint = normalizeFingerprint(body.beforeFingerprint);
      if (!isWellFormedFingerprint(beforeFingerprint)) {
        return send(res, 400, { error: "修复前指纹必须是非空字符串" });
      }
    }
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      beforeFingerprint,
      afterFingerprint: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);

    // 指纹字段一经提供必须合法；记录是否相对现值发生变化
    let nextBeforeFingerprint = damage.beforeFingerprint || "";
    let nextAfterFingerprint = damage.afterFingerprint || "";
    if (body.beforeFingerprint !== undefined) {
      nextBeforeFingerprint = normalizeFingerprint(body.beforeFingerprint);
      if (!isWellFormedFingerprint(nextBeforeFingerprint)) {
        return send(res, 400, { error: "修复前指纹必须是非空字符串" });
      }
    }
    if (body.afterFingerprint !== undefined) {
      nextAfterFingerprint = normalizeFingerprint(body.afterFingerprint);
      if (!isWellFormedFingerprint(nextAfterFingerprint)) {
        return send(res, 400, { error: "修复后指纹必须是非空字符串" });
      }
    }
    const fingerprintChanged =
      nextBeforeFingerprint !== (damage.beforeFingerprint || "") ||
      nextAfterFingerprint !== (damage.afterFingerprint || "");

    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      beforeFingerprint: nextBeforeFingerprint,
      afterFingerprint: nextAfterFingerprint,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });

    // 指纹变更后，已通过项退回待复核
    if (fingerprintChanged) {
      const invalidated = verification.invalidateForDamage(db, damage.id, new Date().toISOString());
      if (invalidated) damage.status = "review_pending";
    }
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const damageIds = body.damageIds.map((id) => String(id));
    if (new Set(damageIds).size !== damageIds.length) return send(res, 400, { error: "damageIds不得重复" });
    const invalid = damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });

    // 建批时冻结每项缺损的修复前指纹；历史缺损缺修复前指纹时不得入批
    const { frozenBeforeFingerprints, missing } = freezeBeforeFingerprints(db, damageIds);
    if (missing.length) {
      return send(res, 400, {
        error: `以下缺损项缺少修复前指纹，不得入批：${missing.join(", ")}`,
        missingBeforeFingerprints: missing
      });
    }

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds,
      frozenBeforeFingerprints,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];

    // 先整批核验：任一项为空、与自身修复前相同或与任一缺损已存前后指纹重复，整批 409，不动任何数据
    const { submitted, conflicts } = validateCompletionFingerprints(db, batch, results);
    if (conflicts.length) {
      return send(res, 409, {
        error: "修复影像指纹核验未通过，批次、缺损和指纹记录均未变更",
        conflicts
      });
    }

    const now = new Date().toISOString();
    batch.status = "completed";
    batch.completedAt = now;
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const submission = submitted.find((item) => item.damageId === damage.id) || {};
      const result = results.find((item) => String(item.damageId) === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.afterFingerprint = submission.afterFingerprint || damage.afterFingerprint;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = now;
      verification.recordPassed(
        db,
        {
          batchId: batch.id,
          damageId: damage.id,
          beforeFingerprint: batch.frozenBeforeFingerprints[damage.id],
          afterFingerprint: submission.afterFingerprint
        },
        now
      );
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

module.exports = { routes, handle };
