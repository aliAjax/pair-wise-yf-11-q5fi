# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次与指纹核验记录。

## 启动

```bash
PORT=3020 node server.js
```

## 代码结构

- `server.js`：服务启动、`db.json` 读写与通用请求工具
- `routes.js`：全部 HTTP 路由编排
- `lib/fingerprintRules.js`：修复影像指纹规则（归一化、建批冻结、完工核验）
- `lib/verificationRecords.js`：指纹核验记录落账与失效

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`（可带 `beforeFingerprint`，缺省为空）
- `GET /damages?status=&type=`
- `PATCH /damages/:id`（可改 `beforeFingerprint` / `afterFingerprint`）
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`

## 修复影像指纹核验

- 缺损项含 `beforeFingerprint`（修复前）与 `afterFingerprint`（修复后），指纹为去首尾空白后的非空字符串。
- **建批冻结**：`POST /batches` 时把每项缺损当前的修复前指纹快照到批次 `frozenBeforeFingerprints`；历史缺损缺修复前指纹时返回 400，不得入批。
- **完工核验**：`POST /batches/:id/complete` 的 `results[].afterFingerprint` 逐项核验，任一冲突整批返回 409，批次、缺损和 `verificationRecords` 均不变：
  - `empty`：修复后指纹为空；
  - `same_as_before`：与该缺损自身冻结的修复前指纹相同；
  - `duplicate`：与任一缺损已存的修复前/修复后指纹（含各批冻结值）重复，或与本批其他提交重复。
- 核验通过后：批次完工，缺损置 `repaired` 并写回修复后指纹，每项生成一条 `status: "passed"` 的核验记录。
- **指纹变更复核**：之后经 `PATCH /damages/:id` 改动任一指纹，若该缺损存在已通过记录，则原记录置 `invalidated` 且缺损状态退回 `review_pending`（待复核）；仅改备注等非指纹字段不受影响。

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"results":[{"damageId":"damage_demo_1","afterFingerprint":"sha256:after-014-1"},{"damageId":"damage_demo_2","afterFingerprint":"sha256:after-014-2"}]}'
```
