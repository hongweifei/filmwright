#!/usr/bin/env node
// filmwright 的可执行入口。真正的逻辑在 src/host/ —— 这里只负责把错误变成退出码和一句话。
import {main} from '../src/host/cli/index.mjs';

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error('\n' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
