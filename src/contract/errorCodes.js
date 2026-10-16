// 全部错误码的登记表。
//
// **新增错误码必须登记到这里** —— `tests/errors.test.mjs` 会扫 `src/` 里出现的
// 所有码名，与本表双向比对：用到未登记的码、或登记了源码没用的码，都算失败。
// 这条判据是有来历的：一个拼错的码名会让 `--json` 悄悄吐出一个没人认识的值，
// 而"报错了"这个现象看起来是对的。
import {ANIM_ERROR_CODES} from './animate.js';
import {EFFECT_ERROR_CODES} from './effects.js';
import {MASK_ERROR_CODES} from './mask.js';

export const ERROR_CODES = [
  ...ANIM_ERROR_CODES,
  ...MASK_ERROR_CODES,
  ...EFFECT_ERROR_CODES,
];
