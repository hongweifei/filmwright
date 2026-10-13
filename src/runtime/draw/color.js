// 颜色工具。hexA 原先住在幕底文件里，但它是通用工具（任何组件都可能要半透明色），
// 放在 draw/ 下才不会被幕底绑住。
/** '#3FA7FF' + 0.2 → 'rgba(63,167,255,0.2)'。支持 3 位缩写。 */
export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
