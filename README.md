# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次和指纹核验记录。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`
- `GET /fingerprint-checks?batchId=&damageId=`

## 修复影像指纹核验

缺损项带 `beforeFingerprint` / `afterFingerprint` 字段（修复影像内容指纹，如 `sha256:...`），可在新建缺损或 `PATCH /damages/:id` 时登记。

- **建批冻结**：`POST /batches` 时为每项缺损冻结修复前指纹，生成待核验记录（`fingerprintChecks`）；缺修复前指纹的历史缺损不得入批，返回 400。
- **完工核验**：`POST /batches/:id/complete` 须在 `results` 中逐项提交 `afterFingerprint`。任一项为空、与自身修复前指纹相同、或与任一缺损已存的前后指纹重复（含批内重复）时，整批返回 409，批次、缺损和指纹记录都不变。
- **写回**：核验通过后，修复后指纹写回缺损项与核验记录，记录置为 `passed`。
- **变更退回**：`PATCH /damages/:id` 变更任一指纹后，已通过（`repaired`）的缺损退回 `recheck` 待复核。

## 闭环示例

```bash
# 历史缺损先补录修复前指纹
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_1 \
  -H 'Content-Type: application/json' -d '{"beforeFingerprint":"sha256:before-014-1"}'
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_2 \
  -H 'Content-Type: application/json' -d '{"beforeFingerprint":"sha256:before-014-2"}'

# 建批（冻结修复前指纹）
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 完工（逐项提交修复后指纹）
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"results":[
    {"damageId":"damage_demo_1","afterFingerprint":"sha256:after-014-1"},
    {"damageId":"damage_demo_2","afterFingerprint":"sha256:after-014-2"}
  ]}'

# 查看核验记录
curl 'http://127.0.0.1:3020/fingerprint-checks?batchId=<batchId>'
```
