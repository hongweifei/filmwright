// 模板镜头：把 scene.json 的一条声明编译成引擎镜头。
//
// 这是「AI 自动化」的质量下限所在 —— AI 只填内容与节拍，这里负责节奏：
//   - 入场错峰：元素跟着对齐句的字幕块（BLK）依次进场，块不够就按时间铺；
//   - 停留不静止：落位后保持呼吸/脉冲（画质自检的静止阈值要求幅度够大，0.5% 等于没动）；
//   - 设计坐标：统一套 applyDesignScale，换分辨率不用改规格；
//   - 配色：accent 由引擎按章节传入，模板不自己挑色。
//
// 注册表的键必须与 contract/scene.js 的 SHOT_TYPES 一致（tests/scene-templates.test.mjs 钉住）。
//
// ⚠️ 本文件原先 1036 行，已按职责拆成 5 个文件（**纯搬运，逻辑一行未改**）：
//   `templates/helpers.js` 共享助手（时间/节奏、逐字入场、摆图）
//   `templates/core.js`    v0 的七个模板
//   `templates/ext.js`     v0.2 扩充的八个模板
//   `templates/registry.js` 注册表（键集与 SHOT_TYPES 一一对应）
//   `compile.js`           编译器
// 这里只做转出 —— 6 处既有 import（3 个测试 + stage/index.js + mcp/server.js + 两个验收工具）
// 都按 `scene/templates.js` 这个路径取东西，桶文件让它们一行都不用改。

export {TEMPLATES} from './templates/registry.js';
export {compileScene} from './compile.js';
