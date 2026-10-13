## 改了什么

<!-- 一句话；列表展开细节。 -->

## 为什么

## 怎么验证的

<!-- 贴实际跑过的命令与结果，例如：
     npm test                         → 72 passed
     filmwright check …（全量）        → 八道全过
     tools/regression.mjs verify …    → 逐字节全同（或：有意改画面，已重新 capture） -->

## 对照清单

- [ ] 分层规则没被破坏（`contract` ← `runtime` ← `host`，镜头只 import `'filmwright'`）
- [ ] 新增的检查/守卫带了负面对照
- [ ] 没有把机器特定内容（绝对路径、本机位置）写进仓库
- [ ] 文档同步更新（docs/、README、LIMITATIONS 中相关处）
- [ ] 提交消息为中文，说明里写明验证方式；故意改画面的已在消息中声明
