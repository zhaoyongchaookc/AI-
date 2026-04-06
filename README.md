# 贷款测算整合工具

## 文件

- `index.html`: 静态页面入口
- `src/loan-engine.js`: 贷款和财政贴息计算引擎
- `src/app.js`: 页面交互
- `styles.css`: 页面样式
- `scripts/extract_config.py`: 从 3 份 Excel 抽取归一化配置
- `data/loan-config.json`: 归一化配置 JSON
- `data/loan-config.js`: 浏览器直接引用的数据模块
- `tests/run-regressions.mjs`: 基于 Excel 默认样例的回归检查

## 使用

1. 运行 `python3 scripts/extract_config.py`
2. 直接打开 [index.html](/Volumes/T11/cursor/利率测算/index.html)
3. 如果浏览器限制本地模块加载，执行 `python3 -m http.server 4173` 后访问 `http://localhost:4173`

## 回归

- 运行 `node tests/run-regressions.mjs`

说明：

- 财政贴息按当前政策表估算，单笔按 `3000` 元封顶
- 跨合同、跨客户的年度累计仍需以最终审核为准
- 逐月明细已按期展示应还总额、本金、利息、品牌贴息、经销商贴息、财政贴息、客户净支付和期末剩余本金
- 双优贷 `1.0 / 2.0` 在财政贴息层按等额本息处理
- 对“车辆贷 + 附加贷”结构，前端默认按 `车价开票价 70%` 计算车辆贷款金额
- 附加项默认由 `购置税 + 保险预估 + 其他附加品` 组成，其中购置税按国标（含税开票价÷1.13×10%，新能源车免征），保险按开票价的 `15%` 估算；购置税与保险在「车贷+附加贷」方案下为系统计算、不可手改
- 为兼容当前品牌表校验，附加贷金额默认按附加项合计的 `80%` 计入，可继续按后续业务口径再调整

