// 模板注册表。**键必须与 `contract/scene.js` 的 `SHOT_TYPES` 一一对应**（tests/scene-templates.test.mjs 钉住）。
import {title, bullets, stat, flowT, code, image, compare} from './core.js';
import {steps, table, quote, terminalT, chips, lineT, barsT, clipT} from './ext.js';
import {threeT} from '../../three/scene3d.js';

/**
 * 模板注册表。键必须与 contract/scene.js 的 SHOT_TYPES 一致 —— 但 `comp` 例外：
 * 它不是模板（没有固定的 draw），而是「引用子合成」的实例化声明，由 compileScene
 * 单独处理（同一份 comps 定义可被多处实例化，还可能带不同的 loop/frames）。
 * 这里给它一个占位，只是为了让注册表键集与 SHOT_TYPES 保持一一对应、便于测试比对。
 */
export const TEMPLATES = {
  title, bullets, stat, flow: flowT, code, image, compare,
  steps, table, quote, terminal: terminalT, chips, bars: barsT, line: lineT,
  clip: clipT,
  three: threeT,
  // comp 由 compileScene 特判，不该走到这里；留着是为了键集一致 + 误用时明确报错
  comp: {draw(ctx, n, shot) { void ctx; void n; void shot;
    throw new Error('filmwright: comp 类型由 compileScene 特判，不应直接调用模板 draw'); }},
};
