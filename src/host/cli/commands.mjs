// 各命令的实现。每个都只做一件事，由 cli/index.mjs 按名字找到并调用。
//
// 约定：命令收到 (ctx) —— {projectDir, proj, args, opts}，返回
//   {code, data, warnings, errors}（退出码 0 成功）。
// data/warnings/errors 只在 --json 时打印（见 cli/output.mjs）；
// 人模式的进度一律走 say()，json 模式自动静默。
//
// ⚠️ 本文件原先 846 行，已按职责拆成 5 个文件（**纯搬运，逻辑一行未改**）：
//   `commands/project.mjs`  check / preview / mcp / srt / clips / newProject
//   `commands/tts.mjs`      tts / voices
//   `commands/media.mjs`    stills / sheet
//   `sharding.mjs`          分片与格式决策（`resolveShards` / `frameFormatOf` / …）
//   `render.mjs`            渲染管线（render / renderSharded / mux / all）
// 这里只做转出 —— 既有 import 有 4 处（`cli/index.mjs` 与 `mcp/server.mjs` 是
// `import * as commands`，另有 3 个测试按名字取），桶让它们一行都不用改。

export * from './commands/project.mjs';
export * from './commands/tts.mjs';
export * from './commands/media.mjs';
export * from './sharding.mjs';
export * from './render.mjs';
