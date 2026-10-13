// 画布尺寸。所有绘制代码读 view.W / view.H，不要写字面量。
//
// 单独一个文件是为了切断循环依赖：config.js 要写它，而绘制代码只读它，
// 不经过 config 的其它导出。
export const view = {W: 1280, H: 720};

/** 设计基准：镜头按这个尺寸写坐标，applyDesignScale 负责换算到实际画布。 */
export const DESIGN = {W: 1280, H: 720};
