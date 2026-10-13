// 库根目录。整个宿主层只在这里算一次路径。
//
// 用 fileURLToPath 而不是手工切 URL —— 手工那版要写
// `.pathname.replace(/^\/([A-Za-z]:)/, '$1')` 来补 Windows 盘符，
// 换个平台/换个转义就错。fileURLToPath 是标准答案，Windows 盘符、
// 空格、中文路径都按平台规则处理。
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

/** 本文件在 <root>/src/host/root.mjs，所以根是它往上三层。 */
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 库自己的渲染页与运行时源码（浏览器要访问的那部分）。 */
export const RUNTIME_ROOT = resolve(KIT_ROOT, 'src');
