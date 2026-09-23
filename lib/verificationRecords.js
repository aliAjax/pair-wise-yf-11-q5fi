"use strict";

// 修复影像指纹核验记录：完工核验通过后落账；指纹变更后使原通过记录失效并退回待复核。

function ensureCollection(db) {
  if (!Array.isArray(db.verificationRecords)) db.verificationRecords = [];
  return db.verificationRecords;
}

function listForBatch(db, batchId) {
  return ensureCollection(db).filter((record) => record.batchId === batchId);
}

// 完工核验通过后，逐项写入核验记录；该缺损此前的通过记录标记为 superseded
function recordPassed(db, { batchId, damageId, beforeFingerprint, afterFingerprint }, now) {
  const records = ensureCollection(db);
  for (const record of records) {
    if (record.damageId === damageId && record.status === "passed") {
      record.status = "superseded";
      record.supersededAt = now;
    }
  }
  const record = {
    id: `verify_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    batchId,
    damageId,
    beforeFingerprint,
    afterFingerprint,
    status: "passed",
    verifiedAt: now
  };
  records.push(record);
  return record;
}

// 指纹变更后，已通过项退回待复核：作废该缺损最近一条通过记录
function invalidateForDamage(db, damageId, now) {
  const records = ensureCollection(db);
  const passed = records
    .filter((record) => record.damageId === damageId && record.status === "passed")
    .sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : -1));
  if (!passed.length) return null;
  const record = passed[0];
  record.status = "invalidated";
  record.invalidatedAt = now;
  return record;
}

module.exports = {
  ensureCollection,
  listForBatch,
  recordPassed,
  invalidateForDamage
};
