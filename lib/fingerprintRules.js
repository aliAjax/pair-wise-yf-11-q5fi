"use strict";

// 修复影像指纹规则：归一化、建批冻结、完工核验。
// 本文件只做纯规则计算，不读写文件、不感知 HTTP 状态码。

const FINGERPRINT_MAX_LENGTH = 256;

// 指纹统一按去首尾空白后的字符串处理；非字符串或空值归一为空串
function normalizeFingerprint(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return "";
  return value.trim();
}

// 合法指纹：非空且不超过长度上限
function isWellFormedFingerprint(value) {
  const fingerprint = normalizeFingerprint(value);
  return fingerprint.length > 0 && fingerprint.length <= FINGERPRINT_MAX_LENGTH;
}

// 建批时逐项冻结修复前指纹；历史缺损缺修复前指纹时不得入批
function freezeBeforeFingerprints(db, damageIds) {
  const frozenBeforeFingerprints = {};
  const missing = [];
  for (const damageId of damageIds) {
    const damage = db.damages.find((item) => item.id === damageId);
    const fingerprint = normalizeFingerprint(damage && damage.beforeFingerprint);
    if (!fingerprint) {
      missing.push(damageId);
      continue;
    }
    frozenBeforeFingerprints[damageId] = fingerprint;
  }
  return { frozenBeforeFingerprints, missing };
}

// 完工指纹核验。任一项满足以下任一条件即判冲突（调用方整批返回 409 且不落库）：
//   1) empty          ：修复后指纹为空
//   2) same_as_before ：与该缺损自身冻结的修复前指纹相同
//   3) duplicate      ：与任一缺损已存的修复前/修复后指纹重复，或与本批其他提交重复
function validateCompletionFingerprints(db, batch, results) {
  const resultsById = new Map();
  if (Array.isArray(results)) {
    for (const item of results) {
      if (item && item.damageId !== undefined && item.damageId !== null) {
        resultsById.set(String(item.damageId), item);
      }
    }
  }

  // 已存指纹池：全部缺损当前的前后指纹 + 各批次冻结的修复前指纹
  const pool = [];
  for (const damage of db.damages) {
    const before = normalizeFingerprint(damage.beforeFingerprint);
    if (before) pool.push({ fingerprint: before, damageId: damage.id, stage: "before" });
    const after = normalizeFingerprint(damage.afterFingerprint);
    if (after) pool.push({ fingerprint: after, damageId: damage.id, stage: "after" });
  }
  for (const existingBatch of db.batches || []) {
    for (const [damageId, value] of Object.entries(existingBatch.frozenBeforeFingerprints || {})) {
      const fingerprint = normalizeFingerprint(value);
      if (fingerprint) pool.push({ fingerprint, damageId, stage: "frozen_before" });
    }
  }

  const frozenOwn = batch.frozenBeforeFingerprints || {};
  const submitted = [];
  const conflicts = [];
  const acceptedInSubmission = new Map();

  for (const damageId of batch.damageIds) {
    const result = resultsById.get(damageId) || {};
    const after = normalizeFingerprint(result.afterFingerprint);
    submitted.push({ damageId, afterFingerprint: after });

    if (!after) {
      conflicts.push({
        damageId,
        reason: "empty",
        message: "修复后指纹为空"
      });
      continue;
    }

    const ownBefore = normalizeFingerprint(frozenOwn[damageId]);
    if (ownBefore && after === ownBefore) {
      conflicts.push({
        damageId,
        reason: "same_as_before",
        beforeFingerprint: ownBefore,
        afterFingerprint: after,
        message: "修复后指纹不得与自身修复前指纹相同"
      });
      continue;
    }

    // 与自身冻结修复前同值的池项上一步已处理，此处放行以免重复报因
    const hit = pool.find(
      (item) =>
        item.fingerprint === after &&
        !(item.damageId === damageId && ownBefore && item.fingerprint === ownBefore)
    );
    if (hit) {
      conflicts.push({
        damageId,
        reason: "duplicate",
        afterFingerprint: after,
        conflictsWith: { damageId: hit.damageId, stage: hit.stage, fingerprint: hit.fingerprint },
        message: `修复后指纹与缺损 ${hit.damageId} 已存的${
          hit.stage === "after" ? "修复后" : "修复前"
        }指纹重复`
      });
      continue;
    }

    const firstOwner = acceptedInSubmission.get(after);
    if (firstOwner) {
      conflicts.push({
        damageId,
        reason: "duplicate",
        afterFingerprint: after,
        conflictsWith: { damageId: firstOwner, stage: "submitted", fingerprint: after },
        message: `修复后指纹与本批缺损 ${firstOwner} 提交的指纹重复`
      });
      continue;
    }

    acceptedInSubmission.set(after, damageId);
  }

  return { submitted, conflicts };
}

module.exports = {
  FINGERPRINT_MAX_LENGTH,
  normalizeFingerprint,
  isWellFormedFingerprint,
  freezeBeforeFingerprints,
  validateCompletionFingerprints
};
