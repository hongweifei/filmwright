// 3D 图层校验（叶子：只依赖共用原语与 `contract/three.js` 的词汇表）。
import {SHAPES, ANIM3D_PROPS, MAX_OBJECTS, THEME_COLOR_KEYS, THREE_ERROR_CODES,
  LIGHT_TYPES, MAX_LIGHTS, LIGHT_ANIM_PROPS} from '../three.js';
import {validateKeyTrack, err} from './primitives.js';


/**
 * 校验一个声明式 3D 镜头（`{"type": "three", "camera": …, "objects": […]}`）。
 *
 * 形状是**有界词汇表**（见 contract/three.js）。动画只走关键帧轨道 ——
 * 复用 `validateKeyTrack`，所以 `beat`/`frame` 锚点、缓动白名单、键序递增
 * 与 `animate` 是**同一套规则**，不复制第二份。
 */
export function validate3D(spec, path = 'three') {
  const out = [];
  const push = (code, where, message, hint) => out.push(err(code, where, message, hint));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    push('SCENE_3D_SHAPE', path, 'three 镜头必须是对象',
      '形如 {"camera":{"z":4.2},"objects":[{"shape":"box","size":1.6,"color":"accent"}]}');
    return out;
  }
  // 通用字段（type/at/transition/transform/animate/effects）由外层统一处理，
  // 这里只管 three 自己的两个。**漏掉通用字段会误报** —— 第一版就报出
  // "three 没有字段 type/at"，等于所有合法写法都过不了。
  const COMMON = ['type', 'at', 'transition', 'transform', 'animate', 'effects', 'mask'];
  for (const k of Object.keys(spec)) {
    if (k === 'camera' || k === 'objects' || k === 'lights' || COMMON.includes(k)) continue;
    push('SCENE_3D_SHAPE', `${path}.${k}`, `three 没有字段 ${JSON.stringify(k)}`,
      '可用：camera / objects / lights（3D 动画写在每个对象的 animate 里）');
  }

  // ── camera ──
  const CAM = ['x', 'y', 'z', 'fov', 'lookAt'];
  if (spec.camera !== undefined) {
    const c = spec.camera;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      push('SCENE_3D_CAMERA', `${path}.camera`, 'camera 必须是对象',
        '形如 {"x":0,"y":0,"z":4.2,"fov":50}；lookAt 是 [x,y,z]');
    } else {
      for (const k of Object.keys(c)) {
        if (!CAM.includes(k)) {
          push('SCENE_3D_CAMERA', `${path}.camera.${k}`, `camera 没有字段 ${JSON.stringify(k)}`,
            `可用：${CAM.join(' / ')}`);
        }
      }
      for (const k of ['x', 'y', 'z', 'fov']) {
        const v = c[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          push('SCENE_3D_CAMERA', `${path}.camera.${k}`, `camera.${k} 必须是数值，收到 ${JSON.stringify(v)}`,
            k === 'fov' ? 'fov：视场角（度），常用 30–70' : `${k}：相机位置（世界单位）`);
        } else if (k === 'fov' && (v <= 1 || v >= 179)) {
          push('SCENE_3D_CAMERA', `${path}.camera.fov`, `fov 超出范围：${v}`,
            'fov：视场角，允许 1–179（常用 30–70）');
        }
      }
      if (c.lookAt !== undefined) {
        const l = c.lookAt;
        if (!Array.isArray(l) || l.length !== 3 || l.some((x) => typeof x !== 'number')) {
          push('SCENE_3D_CAMERA', `${path}.camera.lookAt`, 'lookAt 必须是三个数值的数组',
            '形如 [0, 0, 0]（相机看向的点）');
        }
      }
    }
  }

  // ── lights（可选；给了才切到受光材质）──
  const LIGHT_KEYS = ['type', 'color', 'intensity', 'position', 'animate'];
  if (spec.lights !== undefined) {
    if (!Array.isArray(spec.lights) || !spec.lights.length) {
      push('SCENE_3D_LIGHT', `${path}.lights`, 'lights 必须是非空数组（不想打光就别写这个字段）',
        '形如 [{"type":"directional","intensity":2,"position":[3,4,5]}]');
    } else if (spec.lights.length > MAX_LIGHTS) {
      push('SCENE_3D_LIGHT', `${path}.lights`, `最多 ${MAX_LIGHTS} 盏灯，收到 ${spec.lights.length} 盏`,
        '受光材质的着色成本随灯数上升；够用就好');
    } else {
      spec.lights.forEach((L, i) => {
        const lp = `${path}.lights[${i}]`;
        if (!L || typeof L !== 'object' || Array.isArray(L)) {
          push('SCENE_3D_LIGHT', lp, '每盏灯必须是对象', '形如 {"type":"point","position":[2,3,4]}');
          return;
        }
        for (const k of Object.keys(L)) {
          if (!LIGHT_KEYS.includes(k)) {
            push('SCENE_3D_LIGHT', `${lp}.${k}`, `灯没有字段 ${JSON.stringify(k)}`,
              `可用：${LIGHT_KEYS.join(' / ')}`);
          }
        }
        if (!LIGHT_TYPES.includes(L.type)) {
          push('SCENE_3D_LIGHT', `${lp}.type`, `不认识的光源类型 ${JSON.stringify(L.type)}`,
            `可用：${LIGHT_TYPES.join(' / ')}（ambient 铺底、directional 像太阳、point 像灯泡）`);
        }
        if (L.intensity !== undefined && (typeof L.intensity !== 'number' || !Number.isFinite(L.intensity))) {
          push('SCENE_3D_LIGHT', `${lp}.intensity`, `intensity 必须是数值，收到 ${JSON.stringify(L.intensity)}`,
            'intensity：强度，常用 0.5–3（点光源随距离衰减，需要更大）');
        } else if (L.intensity !== undefined && (L.intensity < 0 || L.intensity > 20)) {
          push('SCENE_3D_LIGHT', `${lp}.intensity`, `intensity 超出范围：${L.intensity}`,
            'intensity：允许 0–20');
        }
        if (L.color !== undefined) {
          const okTheme = THEME_COLOR_KEYS.includes(L.color);
          const okHex = typeof L.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(L.color);
          if (!okTheme && !okHex) {
            push('SCENE_3D_COLOR', `${lp}.color`, `灯的颜色 ${JSON.stringify(L.color)} 不认识`,
              `可用主题色：${THEME_COLOR_KEYS.join(' / ')}；或 #rrggbb`);
          }
        }
        // 位置：ambient 不需要（它没有方向），另两种需要。
        // **但若用关键帧给了 x/y/z，就可以不写静态 position** —— 位置由轨道算出来。
        const anim = L.animate && typeof L.animate === 'object' ? L.animate : null;
        const posFromAnim = !!(anim && ('x' in anim || 'y' in anim || 'z' in anim));
        if (L.type !== 'ambient' && !posFromAnim) {
          if (L.position === undefined) {
            push('SCENE_3D_LIGHT', `${lp}.position`, `${L.type} 光源需要 position`,
              '形如 [3, 4, 5]（世界坐标）；也可以用 animate 的 x/y/z 轨道代替');
          } else if (!Array.isArray(L.position) || L.position.length !== 3
            || L.position.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
            push('SCENE_3D_LIGHT', `${lp}.position`, 'position 必须是三个数值的数组',
              '形如 [3, 4, 5]');
          }
        } else if (L.type === 'ambient' && L.position !== undefined) {
          push('SCENE_3D_LIGHT', `${lp}.position`, 'ambient 光源不需要 position（它没有方向）',
            '要方向就换 directional 或 point');
        }
        // 灯的关键帧：走**同一套**轨道校验（beat/frame 锚点、缓动白名单、键序递增）
        if (L.animate !== undefined) {
          if (!anim) {
            push('SCENE_3D_LIGHT', `${lp}.animate`, 'animate 必须是对象：{属性: [关键帧…]}',
              `可用属性：${LIGHT_ANIM_PROPS.join(' / ')}`);
          } else {
            for (const prop of Object.keys(anim)) {
              if (!LIGHT_ANIM_PROPS.includes(prop)) {
                push('SCENE_3D_LIGHT', `${lp}.animate.${prop}`, `灯的光照动画不支持属性 ${JSON.stringify(prop)}`,
                  `可用：${LIGHT_ANIM_PROPS.join(' / ')}（intensity 脉冲、x/y/z 光扫过；颜色不能动）`);
                continue;
              }
              // ambient 没有方向 ⇒ 位置轨道是**静默空操作**，报出来而不是放过
              if (L.type === 'ambient' && prop !== 'intensity') {
                push('SCENE_3D_LIGHT', `${lp}.animate.${prop}`,
                  `ambient 光源没有方向，${prop} 轨道不会有效果`,
                  'ambient 只支持 intensity 轨道；要让光动就换 directional 或 point');
                continue;
              }
              out.push(...validateKeyTrack(anim[prop], `${lp}.animate.${prop}`, {
                valueNote: prop === 'intensity' ? 'intensity：强度，常用 0.5–3' : `${prop}：世界坐标`,
                checkValue: prop === 'intensity'
                  ? (v, kp, p) => {
                    if (v < 0 || v > 20) {
                      p('SCENE_3D_LIGHT', kp, `intensity 的关键帧值超出范围：${v}`, 'intensity：允许 0–20');
                    }
                  }
                  : null,
              }));
            }
          }
        }
      });
    }
  }

  // ── objects ──
  // 空数组/非数组由**通用字段校验**报（它现在会带上这个形状的示例）——
  // 这里只提前返回，不再重复报一遍（两处报同一件事是噪声）。
  if (!Array.isArray(spec.objects) || !spec.objects.length) return out;
  if (spec.objects.length > MAX_OBJECTS) {
    push('SCENE_3D_OBJECTS', `${path}.objects`,
      `最多 ${MAX_OBJECTS} 个对象，收到 ${spec.objects.length} 个`,
      '每个对象是一次 draw call；要更多就走命令式，或拆成几个镜头');
  }

  const OBJ_KEYS = ['shape', 'size', 'color', 'opacity', 'wireframe', 'position', 'rotate', 'animate', 'material'];
  spec.objects.forEach((o, i) => {
    const op = `${path}.objects[${i}]`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      push('SCENE_3D_SHAPE', op, '每个对象必须是对象', '形如 {"shape":"box","size":1.6}');
      return;
    }
    for (const k of Object.keys(o)) {
      if (!OBJ_KEYS.includes(k)) {
        push('SCENE_3D_SHAPE', `${op}.${k}`, `对象没有字段 ${JSON.stringify(k)}`,
          `可用：${OBJ_KEYS.join(' / ')}`);
      }
    }
    if (!SHAPES.includes(o.shape)) {
      push('SCENE_3D_SHAPE_KIND', `${op}.shape`, `不认识的形状 ${JSON.stringify(o.shape)}`,
        `可用：${SHAPES.join(' / ')}`);
    }
    for (const k of ['size', 'opacity']) {
      const v = o[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        push('SCENE_3D_VALUE', `${op}.${k}`, `${k} 必须是数值，收到 ${JSON.stringify(v)}`,
          k === 'size' ? 'size：尺寸（世界单位），常用 0.2–5' : 'opacity：不透明度 0–1');
      } else if (k === 'size' && (v <= 0 || v > 20)) {
        push('SCENE_3D_VALUE', `${op}.size`, `size 超出范围：${v}`, 'size：允许 0–20（世界单位）');
      } else if (k === 'opacity' && (v < 0 || v > 1)) {
        push('SCENE_3D_VALUE', `${op}.opacity`, `opacity 超出范围：${v}`, 'opacity：允许 0–1');
      }
    }
    if (o.wireframe !== undefined && typeof o.wireframe !== 'boolean') {
      push('SCENE_3D_VALUE', `${op}.wireframe`, 'wireframe 必须是 true/false', '例：true 只画线框');
    }
    if (o.material !== undefined && o.material !== 'basic' && o.material !== 'standard') {
      push('SCENE_3D_VALUE', `${op}.material`, `material 只能是 basic 或 standard，收到 ${JSON.stringify(o.material)}`,
        'basic=不受光（平涂）；standard=受光（有明暗）。默认：有 lights 时 standard，否则 basic');
    }
    if (o.color !== undefined) {
      const okTheme = THEME_COLOR_KEYS.includes(o.color);
      const okHex = typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color);
      if (!okTheme && !okHex) {
        push('SCENE_3D_COLOR', `${op}.color`, `颜色 ${JSON.stringify(o.color)} 不认识`,
          `可用主题色：${THEME_COLOR_KEYS.join(' / ')}；或 #rrggbb`);
      }
    }
    for (const k of ['position', 'rotate']) {
      const v = o[k];
      if (v === undefined) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        push('SCENE_3D_VALUE', `${op}.${k}`, `${k} 必须是 {x,y,z} 对象`,
          '例：{"x":0,"y":0,"z":0}' + (k === 'rotate' ? '（角度制）' : '（世界单位）'));
      } else {
        for (const ax of Object.keys(v)) {
          if (!['x', 'y', 'z'].includes(ax)) {
            push('SCENE_3D_VALUE', `${op}.${k}.${ax}`, `${k} 没有轴 ${JSON.stringify(ax)}`, '可用：x / y / z');
          } else if (typeof v[ax] !== 'number' || !Number.isFinite(v[ax])) {
            push('SCENE_3D_VALUE', `${op}.${k}.${ax}`, `${k}.${ax} 必须是数值`, `例：{"${ax}": 1.5}`);
          }
        }
      }
    }
    // 动画：走**同一套**轨道校验（beat/frame 锚点、缓动白名单、键序递增）
    if (o.animate !== undefined) {
      const an = o.animate;
      if (!an || typeof an !== 'object' || Array.isArray(an)) {
        push('SCENE_3D_ANIM', `${op}.animate`, 'animate 必须是对象：{属性: [关键帧…]}',
          `可用属性：${ANIM3D_PROPS.join(' / ')}`);
      } else {
        for (const prop of Object.keys(an)) {
          if (!ANIM3D_PROPS.includes(prop)) {
            push('SCENE_3D_ANIM', `${op}.animate.${prop}`, `3D 动画不支持属性 ${JSON.stringify(prop)}`,
              `可用：${ANIM3D_PROPS.join(' / ')}（rx/ry/rz 是绕各轴的角度，度）`);
            continue;
          }
          out.push(...validateKeyTrack(an[prop], `${op}.animate.${prop}`, {
            valueNote: prop === 'scale' ? 'scale：倍数，1 为原大' : undefined,
            checkValue: prop === 'scale'
              ? (v, kp, p) => {
                if (v <= 0) p('SCENE_3D_ANIM', kp, `scale 的关键帧值必须 > 0，收到 ${v}`, 'scale 是倍数，1 为原大');
              }
              : null,
          }));
        }
      }
    }
  });
  return out;
}


/**
 * 这个规格里有没有声明式 3D？—— 引擎据此决定**要不要预加载 three**。
 *
 * 为什么需要一个显式判断：three 有 2.2MB，**不用 3D 的项目一个字节都不该加载**。
 * 判断要在**原始规格**上做（在编译成镜头之前），这样图层容器里的 3D 也能被发现。
 */
export function needsThree(scene) {
  if (!scene || typeof scene !== 'object') return false;
  const hits = (shots) => (Array.isArray(shots) ? shots.some((s) => {
    if (!s || typeof s !== 'object') return false;
    if (s.type === 'three') return true;
    if (s.type === 'layers' && Array.isArray(s.layers)) {
      return s.layers.some((l) => l && l.content && l.content.type === 'three');
    }
    return false;
  }) : false);
  if (hits(scene.shots)) return true;
  // comps 是可以被复用的子合成，也要算上
  if (scene.comps) {
    for (const v of Object.values(scene.comps)) {
      if (v && hits(v.shots)) return true;
    }
  }
  return false;
}
