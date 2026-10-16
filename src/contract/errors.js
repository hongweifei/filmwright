// 校验报错的**唯一**构造器：`{code, path, message, hint}`。
//
// 为什么单独一个文件：它是所有校验器的公共依赖（关键帧 / 效果 / 遮罩 / 变换 / 转场），
// 而**码名表**（`errorCodes.js`）要反过来 import 各模块 —— 分开才不会成环。
//
// 形状里的四个字段是给机器读的契约：`--json` 与 MCP 直接把它交给 agent，
// `path` 精确到 `…effects[0].radius[1].ease`，模型读完能直接改那一处。
export const err = (code, path, message, hint) => ({code, path, message, hint});
