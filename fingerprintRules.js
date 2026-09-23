// 修复影像指纹规则：纯函数，不触碰持久化。

function normalizeFingerprint(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isBlankFingerprint(value) {
  return normalizeFingerprint(value) === "";
}

// 汇总库中任一缺损已存的修复前/后指纹（含核验记录里的冻结值），空白不计。
function collectStoredFingerprints(db) {
  const stored = new Map();
  const add = (value, source) => {
    const fingerprint = normalizeFingerprint(value);
    if (fingerprint && !stored.has(fingerprint)) stored.set(fingerprint, source);
  };
  db.damages.forEach((damage) => {
    add(damage.beforeFingerprint, { damageId: damage.id, kind: "before" });
    add(damage.afterFingerprint, { damageId: damage.id, kind: "after" });
  });
  (db.fingerprintChecks || []).forEach((check) => {
    add(check.beforeFingerprint, { damageId: check.damageId, batchId: check.batchId, kind: "before" });
    add(check.afterFingerprint, { damageId: check.damageId, batchId: check.batchId, kind: "after" });
  });
  return stored;
}

// 历史缺损缺修复前指纹时不得入批。
function findMissingBeforeFingerprints(damages) {
  return damages.filter((damage) => isBlankFingerprint(damage.beforeFingerprint)).map((damage) => damage.id);
}

// 完工核验：任一项为空、与自身修复前相同、或与已存前后指纹重复即整批 409。
// 调用方必须先校验通过再写库，保证冲突时批次、缺损和指纹记录都不变。
function validateCompletionFingerprints(db, batch, resultsByDamageId) {
  const stored = collectStoredFingerprints(db);
  const conflicts = [];
  const submitted = new Map();
  [...new Set(batch.damageIds)].forEach((damageId) => {
    const damage = db.damages.find((item) => item.id === damageId);
    if (!damage) {
      conflicts.push({ damageId, reason: "缺损项不存在" });
      return;
    }
    const result = resultsByDamageId.get(damageId) || {};
    const afterFingerprint = normalizeFingerprint(result.afterFingerprint);
    if (!afterFingerprint) {
      conflicts.push({ damageId, reason: "修复后指纹为空" });
      return;
    }
    const frozen = (db.fingerprintChecks || []).find((check) => check.batchId === batch.id && check.damageId === damageId);
    const beforeFingerprints = [frozen && frozen.beforeFingerprint, damage.beforeFingerprint].map(normalizeFingerprint).filter(Boolean);
    if (beforeFingerprints.includes(afterFingerprint)) {
      conflicts.push({ damageId, reason: "修复后指纹与自身修复前指纹相同" });
      return;
    }
    if (submitted.has(afterFingerprint)) {
      conflicts.push({ damageId, reason: "批内提交的修复后指纹重复", conflictWith: { damageId: submitted.get(afterFingerprint) } });
      return;
    }
    if (stored.has(afterFingerprint)) {
      conflicts.push({ damageId, reason: "与任一缺损已存的修复前后指纹重复", conflictWith: stored.get(afterFingerprint) });
      return;
    }
    submitted.set(afterFingerprint, damageId);
  });
  return conflicts;
}

module.exports = {
  normalizeFingerprint,
  isBlankFingerprint,
  collectStoredFingerprints,
  findMissingBeforeFingerprints,
  validateCompletionFingerprints
};
