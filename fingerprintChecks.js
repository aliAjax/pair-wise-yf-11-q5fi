// 核验记录：建批冻结修复前指纹，完工写回修复后指纹与结论。

const { normalizeFingerprint } = require("./fingerprintRules");

function checkId(batchId, damageId) {
  return `check_${batchId}_${damageId}`;
}

function ensureChecks(db) {
  if (!Array.isArray(db.fingerprintChecks)) db.fingerprintChecks = [];
  return db.fingerprintChecks;
}

// 建批时为每项缺损冻结修复前指纹，生成待核验记录。
function freezeBatchChecks(db, batch, now = new Date().toISOString()) {
  const checks = ensureChecks(db);
  [...new Set(batch.damageIds)].forEach((damageId) => {
    const damage = db.damages.find((item) => item.id === damageId);
    if (!damage) return;
    if (checks.some((check) => check.id === checkId(batch.id, damageId))) return;
    checks.push({
      id: checkId(batch.id, damageId),
      batchId: batch.id,
      damageId,
      beforeFingerprint: normalizeFingerprint(damage.beforeFingerprint),
      afterFingerprint: "",
      result: "pending",
      createdAt: now,
      verifiedAt: null
    });
  });
}

// 完工时把逐项提交的修复后指纹写回核验记录与缺损项（调用前须已通过规则校验）。
function passBatchChecks(db, batch, resultsByDamageId, now = new Date().toISOString()) {
  const checks = ensureChecks(db);
  [...new Set(batch.damageIds)].forEach((damageId) => {
    const damage = db.damages.find((item) => item.id === damageId);
    if (!damage) return;
    const result = resultsByDamageId.get(damageId) || {};
    const afterFingerprint = normalizeFingerprint(result.afterFingerprint);
    damage.afterFingerprint = afterFingerprint;
    const check = checks.find((item) => item.id === checkId(batch.id, damageId));
    if (check) {
      check.afterFingerprint = afterFingerprint;
      check.result = "passed";
      check.verifiedAt = now;
    } else {
      // 兜底：历史批次没有冻结记录时补建。
      checks.push({
        id: checkId(batch.id, damageId),
        batchId: batch.id,
        damageId,
        beforeFingerprint: normalizeFingerprint(damage.beforeFingerprint),
        afterFingerprint,
        result: "passed",
        createdAt: now,
        verifiedAt: now
      });
    }
  });
}

// 指纹变更后，已通过项退回待复核。
function applyFingerprintChange(damage, body) {
  const changed = [];
  if (body.beforeFingerprint !== undefined) {
    const next = normalizeFingerprint(body.beforeFingerprint);
    if (next !== normalizeFingerprint(damage.beforeFingerprint)) {
      damage.beforeFingerprint = next;
      changed.push("beforeFingerprint");
    }
  }
  if (body.afterFingerprint !== undefined) {
    const next = normalizeFingerprint(body.afterFingerprint);
    if (next !== normalizeFingerprint(damage.afterFingerprint)) {
      damage.afterFingerprint = next;
      changed.push("afterFingerprint");
    }
  }
  if (changed.length && damage.status === "repaired") {
    damage.status = "recheck";
    damage.repairedAt = null;
  }
  return changed;
}

module.exports = { freezeBatchChecks, passBatchChecks, applyFingerprintChange };
