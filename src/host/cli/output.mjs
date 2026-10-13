// 人机两条输出通道。
//
// 默认给人看：进度、落点、一行结论。
// `--json` 给 agent 看：形状稳定、错误可行动（code/message/hint）——
// 报错是给模型读的 prompt，读完能直接改，而不是一个 exit 1。
//
// 形状（stdout 恰好一个 JSON 文档）：
//   { "ok": bool, "command": "check",
//     "errors":   [{"code": "...", "message": "...", "hint": "..."}],
//     "warnings": ["..."],
//     "data":     { 各命令自己的字段 } }
// 退出码与 ok 一致：0 成功，非 0 失败。

/** 把任意抛出的错误转成一条可行动的 JSON 错误。 */
export function toJsonError(e) {
  return {
    code: (e && e.code) || 'ERROR',
    message: e && e.message ? e.message : String(e),
    ...(e && e.hint ? {hint: e.hint} : {}),
    ...(e && e.where ? {where: e.where} : {}),
  };
}

/** 打印结果 JSON（stdout 只此一个文档，日志必须已被抑制）。 */
export function emitJson(result) {
  console.log(JSON.stringify(result, null, 2));
}

/** 命令里的进度输出：json 模式静默，人模式照常打印。 */
export function makeSay(args) {
  const json = args.json === true;
  return (msg) => {
    if (!json) console.log(msg);
  };
}

export const isJson = (args) => args.json === true;
