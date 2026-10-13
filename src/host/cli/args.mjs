// 参数解析：极小、无依赖。`--k v` 或 `--flag`。
export function parseArgs(argv) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** 取整数参数，非法就报错（不要静默 NaN）。 */
export function num(args, key, def) {
  if (args[key] === undefined) {
    if (def === undefined) throw new Error(`filmwright: 缺 --${key}`);
    return def;
  }
  const n = parseInt(args[key], 10);
  if (!Number.isFinite(n)) throw new Error(`filmwright: --${key} 要是整数，收到 ${args[key]}`);
  return n;
}

export function str(args, key, def) {
  if (args[key] === undefined) {
    if (def === undefined) throw new Error(`filmwright: 缺 --${key}`);
    return def;
  }
  return String(args[key]);
}
