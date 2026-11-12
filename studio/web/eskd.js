/* AI Чертежи — оформление чертежей по ЕСКД.
 *
 * Рамка листа и основная надпись, слои и типы линий, текстовый и размерный стили, размеры у
 * выделенного и проверка чертежа. Всё строится обычными командами редактора через
 * window.aiautocad (линии, полилинии, надписи, LAYER, LINETYPE, STYLE, DIMSTYLE), поэтому каждое
 * действие видно в чертеже, сохраняется в DWG/DXF и отменяется одним Ctrl+Z.
 *
 * По стандартам (их общедоступные тексты):
 *  - ГОСТ 2.301 — форматы A4–A0;
 *  - ГОСТ 2.104 — рамка (поля 20 мм слева, 5 мм с остальных сторон), основная надпись форма 1, 185×55 мм;
 *  - ГОСТ 2.302 — масштабы;
 *  - ГОСТ 2.303 — типы линий (толщина основной S = 0,5 мм, тонкие S/3…S/2);
 *  - ГОСТ 2.304 — шрифт (размеры 2,5; 3,5; 5; 7; 10; 14; наклон 75° к основанию строки);
 *  - ГОСТ 2.307 — размеры (не ближе 10 мм от контура, между параллельными — не меньше 7 мм).
 * Типы линий ниже — наши определения по длинам штрихов и промежутков из ГОСТ 2.303.
 *
 * Используется из studio.js (инструменты помощника и быстрые задачи): window.aiautocadEskd.
 * Каждой функции передаётся PC — обёртка моста с call(method, params) и exec(command, params).
 */
(() => {
  'use strict';

  // ГОСТ 2.301: размеры форматов (ширина × высота при вертикальном расположении), мм.
  const FORMATS = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };
  // ГОСТ 2.302: масштабы уменьшения и увеличения (во сколько раз чертёж больше листа).
  const SCALES = [['1:1', 1], ['1:2', 2], ['1:2,5', 2.5], ['1:4', 4], ['1:5', 5], ['1:10', 10], ['1:15', 15], ['1:20', 20], ['1:25', 25], ['1:40', 40], ['1:50', 50], ['1:75', 75], ['1:100', 100], ['1:200', 200], ['1:400', 400], ['1:500', 500], ['1:800', 800], ['1:1000', 1000]];
  const ENLARGE = [['2:1', 0.5], ['2,5:1', 0.4], ['4:1', 0.25], ['5:1', 0.2], ['10:1', 0.1], ['20:1', 0.05], ['40:1', 0.025], ['50:1', 0.02], ['100:1', 0.01]];
  // ГОСТ 2.304: размеры шрифта, мм.
  const FONT_SIZES = [1.8, 2.5, 3.5, 5, 7, 10, 14, 20, 28, 40];

  // ГОСТ 2.303: типы линий. Длины — в миллиметрах на листе (LTSCALE 1 при масштабе 1:1).
  const LINETYPES = `;; AI Чертежи: типы линий по ГОСТ 2.303 (наши определения длин штрихов и промежутков).
*GOST_DASHED,Штриховая ГОСТ 2.303 (штрих 5, промежуток 1,5) __ __ __
A,5,-1.5
*GOST_DASHDOT,Штрихпунктирная тонкая ГОСТ 2.303 (штрих 15, промежуток 4) ___ . ___ .
A,15,-2,0,-2
*GOST_DASHDOT_THICK,Штрихпунктирная утолщённая ГОСТ 2.303 (штрих 6, промежуток 3) __ . __ .
A,6,-1.5,0,-1.5
*GOST_DASHDOT2,Штрихпунктирная с двумя точками ГОСТ 2.303 (штрих 20, промежуток 6) ___ .. ___ ..
A,20,-2,0,-2,0,-2
*GOST_OPEN,Разомкнутая ГОСТ 2.303 (штрих 12, промежуток 20) ___    ___
A,12,-20
`;
  // Слои: имя, цвет (номер ACI), тип линии, толщина (мм), назначение.
  const LAYERS = [
    ['Основная', 7, 'Continuous', 0.5, 'Сплошная толстая основная: видимый контур'],
    ['Тонкая', 3, 'Continuous', 0.25, 'Сплошная тонкая: линии построения, выноски, контур наложенного сечения'],
    ['Осевая', 1, 'GOST_DASHDOT', 0.25, 'Штрихпунктирная тонкая: осевые и центровые линии'],
    ['Штриховая', 5, 'GOST_DASHED', 0.25, 'Штриховая: невидимый контур'],
    ['Размеры', 3, 'Continuous', 0.25, 'Размерные и выносные линии, размерные числа'],
    ['Текст', 7, 'Continuous', 0.25, 'Надписи и технические требования'],
    ['Штриховка', 8, 'Continuous', 0.25, 'Штриховка разрезов и сечений'],
    ['Рамка', 7, 'Continuous', 0.5, 'Рамка листа и основная надпись'],
  ];
  const TEXT_STYLE = 'ГОСТ 2.304';
  const DIM_STYLE = 'ГОСТ 2.307';
  const GOST_LINETYPES = new Set(['continuous', 'bylayer', 'byblock', 'gost_dashed', 'gost_dashdot', 'gost_dashdot_thick', 'gost_dashdot2', 'gost_open']);

  const r2 = (v) => Math.round(v * 1000) / 1000;
  const pt = (x, y) => [r2(x), r2(y)];
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  // Всё действие — один шаг отмены.
  let depth = 0;
  async function grouped(PC, fn) {
    // Вложенные вызовы (лист создаёт слои) — внутри одной группы.
    if (depth++ === 0) await PC.exec('undo', { mode: 'begin' }).catch(() => {});
    try { return await fn(); } finally { if (--depth === 0) await PC.exec('undo', { mode: 'end' }).catch(() => {}); }
  }
  // Высота надписи из ряда ГОСТ 2.304, при которой текст помещается в графу шириной width (мм листа).
  function fitHeight(s, h, width) {
    const n = [...String(s || '')].length;
    for (const size of [14, 10, 7, 5, 3.5, 2.5, 1.8]) if (size <= h && n * size * 0.62 <= width) return size;
    return 1.8;
  }
  async function inspect(PC) { return PC.call('drawing.inspect', { entities: false }); }
  async function allObjects(PC, filter, max = 5000) {
    const out = [];
    for (let offset = 0; out.length < max; offset += 500) {
      const r = await PC.exec('entities', Object.assign({ limit: 500, offset }, filter || {}));
      const list = (r && r.entities) || [];
      out.push(...list);
      if (list.length < 500) break;
    }
    return out;
  }
  const XY = (v) => (Array.isArray(v) ? { x: Number(v[0]), y: Number(v[1]) } : { x: Number(v && v.x), y: Number(v && v.y) });

  // ------------------------------------------------------------------ слои, типы линий, стили
  // Слои и типы линий по ГОСТ 2.303, текстовый стиль по ГОСТ 2.304, размерный по ГОСТ 2.307.
  // Уже существующие слои не меняются (кроме недостающего типа линии); текущий слой не меняется.
  async function setup(PC, args = {}) {
    return grouped(PC, async () => {
      const d = await inspect(PC);
      const done = [];
      const have = new Set((d.linetypes || []).map((n) => String(n).toLowerCase()));
      if (!['gost_dashed', 'gost_dashdot', 'gost_dashdot2'].every((n) => have.has(n))) {
        await PC.exec('linetype', { load: 'GOST_*', text: LINETYPES });
        done.push('типы линий ГОСТ 2.303');
      }
      const existing = new Map((d.layers || []).map((l) => [String(l.name).toLowerCase(), l]));
      const made = [];
      for (const [name, color, linetype, lineweight, description] of LAYERS) {
        const l = existing.get(name.toLowerCase());
        if (!l) {
          await PC.exec('layer.new', { name, color, linetype, lineweight, current: false });
          await PC.exec('layer.set', { name, description }).catch(() => {});
          made.push(name);
        } else if (linetype !== 'Continuous' && String(l.linetype || '').toLowerCase() === 'continuous') {
          await PC.exec('layer.set', { name, linetype }).catch(() => {});
        }
      }
      if (made.length) done.push('слои: ' + made.join(', '));
      const styles = new Set((d.textStyles || []).map((n) => String(n).toLowerCase()));
      if (!styles.has(TEXT_STYLE.toLowerCase())) {
        // Чертёжного шрифта по ГОСТ 2.304 среди открытых нет: Arial (в браузере — Liberation Sans,
        // метрически совместимый) с наклоном 15° (75° к основанию строки), как шрифт типа Б с наклоном.
        await PC.exec('style', { name: TEXT_STYLE, font: 'arial.ttf', height: 0, widthFactor: 1, oblique: 15, current: false });
        done.push('текстовый стиль «' + TEXT_STYLE + '»');
      }
      const dims = new Set((d.dimStyles || []).map((n) => String(n).toLowerCase()));
      if (!dims.has(DIM_STYLE.toLowerCase())) {
        await PC.exec('dimstyle', {
          name: DIM_STYLE, current: true,
          DIMTXT: 3.5, DIMASZ: 3, DIMEXE: 2, DIMEXO: 0, DIMGAP: 1, DIMTAD: 1, DIMTIH: 0, DIMTOH: 0,
          DIMDEC: 2, DIMZIN: 8, DIMDSEP: ',', DIMLUNIT: 2, DIMTXSTY: TEXT_STYLE, DIMDLI: 7, DIMCLRD: 0, DIMCLRE: 0, DIMCLRT: 0,
        });
        done.push('размерный стиль «' + DIM_STYLE + '»');
      }
      if (args.current !== false) await PC.exec('style', { name: TEXT_STYLE, current: true }).catch(() => {});
      if (num(d.ltscale, 1) !== 1) await PC.exec('ltscale', { scale: 1 }).catch(() => {});
      await PC.exec('lwdisplay', { on: true }).catch(() => {});
      return {
        message: done.length ? 'Создано: ' + done.join('; ') + '.' : 'Слои, типы линий и стили ГОСТ уже есть в чертеже.',
        layers: LAYERS.map(([name, , linetype, lineweight, what]) => ({ name, linetype, lineweight, what })),
        textStyle: TEXT_STYLE + ' (arial.ttf, наклон 15°; в браузере — Liberation Sans)',
        dimStyle: DIM_STYLE + ' (текст 3,5 мм, стрелки 3 мм, десятичная запятая)',
      };
    });
  }

  // ------------------------------------------------------------------ рамка и основная надпись
  // Линии основной надписи формы 1 (ГОСТ 2.104) от её левого нижнего угла: [x1, y1, x2, y2, толстая?].
  function stampLines() {
    const L = [];
    const thick = (x1, y1, x2, y2) => L.push([x1, y1, x2, y2, true]);
    const thin = (x1, y1, x2, y2) => L.push([x1, y1, x2, y2, false]);
    // Левая часть 65 мм: графы 14–18 (изменения, шапка) и 10–13 (подписи).
    for (const x of [17, 40, 55]) thick(x, 0, x, 55);
    thick(7, 30, 7, 55);
    thick(65, 0, 65, 55);
    thick(0, 30, 65, 30);
    thick(0, 35, 65, 35);
    for (const y of [5, 10, 15, 20, 25, 40, 45, 50]) thin(0, y, 65, y);
    // Правая часть: графа 2 (обозначение) сверху, графа 1 (наименование), 3 (материал), справа 4–9.
    thick(65, 40, 185, 40);
    thick(65, 15, 185, 15);
    thick(135, 0, 135, 40);
    thick(135, 35, 185, 35);
    thick(135, 20, 185, 20);
    thick(150, 20, 150, 40);
    thick(167, 20, 167, 40);
    thin(140, 20, 140, 35);
    thin(145, 20, 145, 35);
    thin(155, 15, 155, 20);
    return L;
  }
  // Подписи граф: [текст, x, y, высота, выравнивание].
  function stampLabels() {
    return [
      ['Изм.', 3.5, 32.5, 2.5, 'MC'], ['Лист', 12, 32.5, 2.5, 'MC'], ['№ докум.', 28.5, 32.5, 2.5, 'MC'], ['Подп.', 47.5, 32.5, 2.5, 'MC'], ['Дата', 60, 32.5, 2.5, 'MC'],
      ['Разраб.', 1, 27.5, 2.5, 'ML'], ['Пров.', 1, 22.5, 2.5, 'ML'], ['Т.контр.', 1, 17.5, 2.5, 'ML'], ['Н.контр.', 1, 7.5, 2.5, 'ML'], ['Утв.', 1, 2.5, 2.5, 'ML'],
      ['Лит.', 142.5, 37.5, 2.5, 'MC'], ['Масса', 158.5, 37.5, 2.5, 'MC'], ['Масштаб', 176, 37.5, 2.5, 'MC'],
      ['Лист', 136, 17.5, 2.5, 'ML'], ['Листов', 156, 17.5, 2.5, 'ML'],
    ];
  }
  // Масштаб по ГОСТ 2.302, при котором объекты (ширина × высота, мм) помещаются в поле листа.
  function pickScale(w, h, fieldW, fieldH) {
    if (!(w > 0 || h > 0)) return SCALES[0];
    for (const s of SCALES) if (w <= fieldW * s[1] && h <= fieldH * s[1]) return s;
    return SCALES[SCALES.length - 1];
  }
  function parseScale(v) {
    const t = String(v || '').trim().replace('.', ',');
    return SCALES.find((s) => s[0] === t) || ENLARGE.find((s) => s[0] === t) || null;
  }
  async function drawLine(PC, a, b) {
    const r = await PC.exec('line', { points: [a, b] });
    return (r && (r.handles || (r.handle ? [r.handle] : []))) || [];
  }
  async function text(PC, s, at, height, justify) {
    if (!String(s || '').trim()) return null;
    return PC.exec('text', { at, text: String(s), height: r2(height), justify });
  }

  // Рамка листа A4–A0 с полями 20/5 мм и основной надписью формы 1 по ГОСТ 2.104.
  // args: format (A4…A0), orientation (portrait|landscape), scale ("1:2"; без него — подбирается
  // по объектам чертежа), at [x, y] (левый нижний угол листа), поля основной надписи: name,
  // designation, material, organization, developer, checker, tcontrol, ncontrol, approver, date,
  // litera, mass, sheet, sheets.
  async function sheet(PC, args = {}) {
    const format = String(args.format || 'A4').toUpperCase().replace('А', 'A');
    const size = FORMATS[format];
    if (!size) throw new Error('Формат должен быть A4, A3, A2, A1 или A0');
    let landscape = String(args.orientation || '').toLowerCase().startsWith('land') || /гориз|альбом/i.test(String(args.orientation || ''));
    if (format === 'A4' && !args.orientation) landscape = false;
    const [W, H] = landscape ? [size[1], size[0]] : size;
    const d = await inspect(PC);
    const ext = Array.isArray(d.extents) ? d.extents.map(XY) : null;
    // Поле для изображения: внутри рамки и над основной надписью.
    const fieldW = W - 25, fieldH = H - 10 - 55;
    let scale = parseScale(args.scale);
    const objW = ext ? ext[1].x - ext[0].x : 0, objH = ext ? ext[1].y - ext[0].y : 0;
    if (!scale) scale = ext ? pickScale(objW + 20, objH + 20, fieldW, fieldH) : SCALES[0];
    const k = scale[1];
    let x0, y0;
    let placed;
    if (Array.isArray(args.at) && args.at.length >= 2) {
      [x0, y0] = [num(args.at[0], 0), num(args.at[1], 0)];
      placed = 'в заданной точке';
    } else if (ext && Number.isFinite(objW) && Number.isFinite(objH)) {
      // Объекты — в середине поля над основной надписью.
      const cx = (ext[0].x + ext[1].x) / 2, cy = (ext[0].y + ext[1].y) / 2;
      x0 = cx - (20 + fieldW / 2) * k;
      y0 = cy - (5 + 55 + fieldH / 2) * k;
      placed = 'вокруг объектов чертежа';
    } else {
      [x0, y0] = [0, 0];
      placed = 'в начале координат';
    }
    const P = (x, y) => pt(x0 + x * k, y0 + y * k);
    return grouped(PC, async () => {
      await setup(PC, { current: false });
      const before = d.currentLayer || '0';
      // Всё — на слое Рамка (основная линия 0,5 мм); тонкие линии — с толщиной 0,25 мм у самих объектов.
      // Внешняя рамка (линия обреза листа) — тонкая, внутренняя — основная.
      await PC.exec('layer.current', { name: 'Рамка' });
      const thinHandles = [];
      const outer = await PC.exec('pline', { vertices: [P(0, 0), P(W, 0), P(W, H), P(0, H)], closed: true });
      if (outer && outer.handle) thinHandles.push(outer.handle);
      await PC.exec('pline', { vertices: [P(20, 5), P(W - 5, 5), P(W - 5, H - 5), P(20, H - 5)], closed: true });
      // Основная надпись — в правом нижнем углу рамки.
      const sx = W - 5 - 185, sy = 5;
      const S = (x, y) => P(sx + x, sy + y);
      const lines = stampLines();
      for (const [x1, y1, x2, y2] of lines.filter((l) => l[4])) await drawLine(PC, S(x1, y1), S(x2, y2));
      for (const [x1, y1, x2, y2] of lines.filter((l) => !l[4])) thinHandles.push(...(await drawLine(PC, S(x1, y1), S(x2, y2))));
      if (thinHandles.length) await PC.exec('properties.set', { handles: thinHandles, lineweight: 0.25 }).catch(() => {});
      await PC.exec('layer.current', { name: 'Текст' });
      await PC.exec('style', { name: TEXT_STYLE, current: true }).catch(() => {});
      for (const [s, x, y, h, j] of stampLabels()) await text(PC, s, S(x, y), h * k, j);
      // Значения граф.
      const f = args;
      const sheets = num(f.sheets, 1);
      const designation = String(f.designation || 'Обозначение');
      await text(PC, designation, S(125, 47.5), fitHeight(designation, 7, 116) * k, 'MC');
      const name = String(f.name || 'Наименование');
      if (fitHeight(name, 5, 66) < 3.5) {
        await PC.exec('mtext', { at: S(100, 27.5), text: name, height: r2(3.5 * k), width: r2(66 * k), justify: 'MC' });
      } else {
        await text(PC, name, S(100, 27.5), fitHeight(name, 5, 66) * k, 'MC');
      }
      const material = String(f.material || 'Материал');
      await text(PC, material, S(100, 7.5), fitHeight(material, 5, 66) * k, 'MC');
      if (f.organization) await text(PC, f.organization, S(160, 7.5), fitHeight(f.organization, 3.5, 47) * k, 'MC');
      await text(PC, scale[0], S(176, 27.5), 5 * k, 'MC');
      if (f.mass) await text(PC, f.mass, S(158.5, 27.5), fitHeight(f.mass, 3.5, 15) * k, 'MC');
      if (f.litera) await text(PC, f.litera, S(137.5, 27.5), fitHeight(f.litera, 3.5, 4.5) * k, 'MC');
      await text(PC, sheets > 1 ? String(num(f.sheet, 1)) : '', S(148, 17.5), 2.5 * k, 'ML');
      await text(PC, String(sheets), S(172, 17.5), 2.5 * k, 'ML');
      const people = [[f.developer, 27.5], [f.checker, 22.5], [f.tcontrol, 17.5], [f.ncontrol, 7.5], [f.approver, 2.5]];
      for (const [who, y] of people) if (who) await text(PC, who, S(18, y), fitHeight(who, 2.5, 21) * k, 'ML');
      if (f.date) for (const [who, y] of people) if (who) await text(PC, f.date, S(60, y), fitHeight(f.date, 2.5, 9.5) * k, 'MC');
      await PC.exec('layer.current', { name: before }).catch(() => {});
      await PC.exec('zoom', { mode: 'window', p1: P(-5, -5), p2: P(W + 5, H + 5) }).catch(() => PC.exec('zoom.extents').catch(() => {}));
      const fits = !ext || (objW <= fieldW * k && objH <= fieldH * k);
      return {
        message: `Лист ${format}${landscape ? ' (горизонтально)' : ''} ${W}×${H} мм, масштаб ${scale[0]}: рамка с полями 20/5 мм и основная надпись по ГОСТ 2.104 форма 1 — ${placed}.`
          + (k !== 1 ? ` Рамка начерчена в ${k} раз${k >= 2 && k <= 4 ? 'а' : ''} ${k > 1 ? 'крупнее' : 'мельче'} листа, чтобы чертёж в натуральную величину поместился; печатать в масштабе ${scale[0]}.` : '')
          + (fits ? '' : ' Объекты не помещаются в поле листа — выберите формат больше или другой масштаб.'),
        format, orientation: landscape ? 'landscape' : 'portrait', scale: scale[0], sheetMm: [W, H],
        corner: P(0, 0), stampCorner: S(0, 0),
        fields: 'графы с подписями: обозначение (над наименованием), наименование, материал, организация, масштаб, листы, Разраб., Пров., Т.контр., Н.контр., Утв.',
      };
    });
  }

  // ------------------------------------------------------------------ размеры у выделенного
  // ГОСТ 2.307: размерная линия не ближе 10 мм от контура. Отрезки — параллельный размер, окружности —
  // диаметр, дуги — радиус, замкнутые полилинии — габариты (горизонтальный снизу, вертикальный справа),
  // открытые полилинии — каждый прямой участок.
  async function dimensionSelected(PC, args = {}) {
    const list = (await PC.exec('entities', { selected: true, limit: 200 })).entities || [];
    if (!list.length) throw new Error('Ничего не выделено. Выделите отрезки, окружности, дуги или полилинии.');
    const gap = num(args.offset, 10);
    // Центр выделенного: размеры выносятся наружу от него.
    const pts = [];
    for (const e of list) {
      const g = e.geometry || {};
      if (g.type === 'line') pts.push(XY(g.a), XY(g.b));
      else if (g.center) pts.push(XY(g.center));
      else if (Array.isArray(g.vertices)) for (const v of g.vertices) pts.push(XY(v.p));
    }
    const c = pts.length ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length } : { x: 0, y: 0 };
    const aligned = async (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) return false;
      let nx = -dy / len, ny = dx / len;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if ((mx - c.x) * nx + (my - c.y) * ny < 0) { nx = -nx; ny = -ny; }
      await PC.exec('dimaligned', { p1: pt(a.x, a.y), p2: pt(b.x, b.y), at: pt(mx + nx * gap, my + ny * gap) });
      return true;
    };
    return grouped(PC, async () => {
      const d = await inspect(PC);
      const before = d.currentLayer || '0';
      if (!(d.layers || []).some((l) => l.name === 'Размеры')) await PC.exec('layer.new', { name: 'Размеры', color: 3, lineweight: 0.25, current: false }).catch(() => {});
      await PC.exec('layer.current', { name: 'Размеры' }).catch(() => {});
      if ((d.dimStyles || []).includes(DIM_STYLE)) await PC.exec('dimstyle', { name: DIM_STYLE, current: true }).catch(() => {});
      let made = 0;
      const skipped = new Set();
      for (const e of list) {
        const g = e.geometry || {};
        try {
          if (g.type === 'line') { if (await aligned(XY(g.a), XY(g.b))) made++; }
          else if (g.type === 'circle') {
            const o = XY(g.center), r = Number(g.radius);
            await PC.exec('dimdiameter', { handle: e.handle, at: pt(o.x + r * 0.7071 + gap * 0.7071, o.y + r * 0.7071 + gap * 0.7071) });
            made++;
          } else if (g.type === 'arc') {
            const o = XY(g.center), r = Number(g.radius);
            let a0 = Number(g.start), a1 = Number(g.end);
            if (a1 < a0) a1 += Math.PI * 2;
            const m = (a0 + a1) / 2;
            await PC.exec('dimradius', { handle: e.handle, at: pt(o.x + (r + gap) * Math.cos(m), o.y + (r + gap) * Math.sin(m)) });
            made++;
          } else if (g.type === 'lwPolyline') {
            const v = (g.vertices || []).map((q) => XY(q.p));
            if (v.length < 2) continue;
            if (g.closed) {
              const minX = Math.min(...v.map((p) => p.x)), maxX = Math.max(...v.map((p) => p.x));
              const minY = Math.min(...v.map((p) => p.y)), maxY = Math.max(...v.map((p) => p.y));
              const left = v.reduce((m, p) => (p.x < m.x - 1e-9 || (Math.abs(p.x - m.x) <= 1e-9 && p.y < m.y) ? p : m));
              const right = v.reduce((m, p) => (p.x > m.x + 1e-9 || (Math.abs(p.x - m.x) <= 1e-9 && p.y < m.y) ? p : m));
              const bottom = v.reduce((m, p) => (p.y < m.y - 1e-9 || (Math.abs(p.y - m.y) <= 1e-9 && p.x > m.x) ? p : m));
              const top = v.reduce((m, p) => (p.y > m.y + 1e-9 || (Math.abs(p.y - m.y) <= 1e-9 && p.x > m.x) ? p : m));
              if (maxX - minX > 1e-6) { await PC.exec('dimlinear', { p1: pt(left.x, left.y), p2: pt(right.x, right.y), at: pt((minX + maxX) / 2, minY - gap), rotation: 0 }); made++; }
              if (maxY - minY > 1e-6) { await PC.exec('dimlinear', { p1: pt(bottom.x, bottom.y), p2: pt(top.x, top.y), at: pt(maxX + gap, (minY + maxY) / 2), rotation: 90 }); made++; }
            } else {
              for (let i = 0; i + 1 < v.length && i < 40; i++) {
                if ((g.vertices[i].bulge || 0) !== 0) continue;
                if (await aligned(v[i], v[i + 1])) made++;
              }
            }
          } else {
            skipped.add(e.type || g.type);
          }
        } catch (err) {
          skipped.add((e.type || g.type) + ': ' + (err.message || err));
        }
      }
      await PC.exec('layer.current', { name: before }).catch(() => {});
      return {
        message: `Проставлено размеров: ${made}` + (skipped.size ? `. Пропущено: ${[...skipped].slice(0, 5).join('; ')}` : '') + '.',
        dimensions: made,
      };
    });
  }

  // ------------------------------------------------------------------ проверка чертежа
  // Незамкнутые контуры (свободные концы отрезков, дуг и открытых полилиний), отрезки нулевой длины,
  // объекты на слое 0, типы линий не по ГОСТ 2.303, высоты текста не по ГОСТ 2.304, пустые надписи.
  async function check(PC) {
    const d = await inspect(PC);
    const all = await allObjects(PC, null, 20000);
    const tol = 0.01;
    const key = (p) => `${Math.round(p.x / tol)}:${Math.round(p.y / tol)}`;
    const ends = new Map();
    const addEnd = (p, h) => { const k = key(p); const e = ends.get(k) || { p, n: 0, handles: [] }; e.n++; if (e.handles.length < 3) e.handles.push(h); ends.set(k, e); };
    let zero = 0;
    const onZero = [];
    const texts = [];
    const emptyTexts = [];
    const openPolylines = [];
    const counts = {};
    for (const e of all) {
      const g = e.geometry || {};
      counts[e.type] = (counts[e.type] || 0) + 1;
      // Рамка и основная надпись — из отдельных линий, их концы свободны по замыслу.
      if (e.layer === 'Рамка') continue;
      if (e.layer === '0' && g.type !== 'viewport') onZero.push(e.handle);
      if (g.type === 'line') {
        const a = XY(g.a), b = XY(g.b);
        if (Math.hypot(b.x - a.x, b.y - a.y) < tol) { zero++; continue; }
        addEnd(a, e.handle); addEnd(b, e.handle);
      } else if (g.type === 'arc') {
        const o = XY(g.center), r = Number(g.radius);
        addEnd({ x: o.x + r * Math.cos(g.start), y: o.y + r * Math.sin(g.start) }, e.handle);
        addEnd({ x: o.x + r * Math.cos(g.end), y: o.y + r * Math.sin(g.end) }, e.handle);
      } else if (g.type === 'lwPolyline' && !g.closed) {
        const v = (g.vertices || []).map((q) => XY(q.p));
        if (v.length >= 2) {
          const first = v[0], last = v[v.length - 1];
          if (Math.hypot(last.x - first.x, last.y - first.y) < tol) openPolylines.push(e.handle);
          else { addEnd(first, e.handle); addEnd(last, e.handle); }
        }
      } else if (g.type === 'text' || g.type === 'mText') {
        const h = Number(g.height);
        const value = g.type === 'text' ? String(g.value || '') : String(g.contents || '');
        if (!value.trim()) emptyTexts.push(e.handle);
        if (Number.isFinite(h) && h > 0) texts.push({ handle: e.handle, height: h });
      }
    }
    const dangling = [...ends.values()].filter((e) => e.n === 1);
    // Высоты текста: ряд ГОСТ 2.304 (с учётом масштаба 1:k рамки — допускаем кратные стандартным).
    const okHeight = (h) => FONT_SIZES.some((s) => [1, 2, 2.5, 4, 5, 10, 20, 25, 50, 100].some((k) => Math.abs(h - s * k) < 0.01 * k));
    const badHeights = [...new Set(texts.filter((t) => !okHeight(t.height)).map((t) => Math.round(t.height * 100) / 100))].slice(0, 10);
    let layerInfo = null;
    try { layerInfo = await PC.exec('layer', {}); } catch { /* только то, что есть в inspect */ }
    const layers = (layerInfo && Array.isArray(layerInfo.layers) ? layerInfo.layers : d.layers) || [];
    const nonGost = layers.filter((l) => l.linetype && !GOST_LINETYPES.has(String(l.linetype).toLowerCase())).map((l) => `${l.name}: ${l.linetype}`);
    const axisLike = layers.filter((l) => /осев|ось|axis|center|centre/i.test(l.name) && /^continuous$/i.test(String(l.linetype || ''))).map((l) => l.name);
    const hiddenLike = layers.filter((l) => /штрих|невид|hidden|dash/i.test(l.name) && !/штрихов[кa]/i.test(l.name) && /^continuous$/i.test(String(l.linetype || ''))).map((l) => l.name);
    const mm = (v) => parseFloat(String(v ?? '').replace(',', '.'));
    const weights = layers.filter((l) => mm(l.lineweight) > 0 && ![0.18, 0.2, 0.25, 0.3, 0.35, 0.5, 0.7, 1, 1.4].includes(Math.round(mm(l.lineweight) * 100) / 100)).map((l) => `${l.name}: ${l.lineweight}`);
    const issues = [];
    if (dangling.length) issues.push({ what: 'Незамкнутые контуры: свободные концы линий', count: dangling.length, where: dangling.slice(0, 15).map((e) => ({ at: pt(e.p.x, e.p.y), handles: e.handles })) });
    if (openPolylines.length) issues.push({ what: 'Полилинии, у которых конец совпадает с началом, но они не замкнуты (pedit → close)', count: openPolylines.length, handles: openPolylines.slice(0, 20) });
    if (zero) issues.push({ what: 'Отрезки нулевой длины', count: zero });
    if (onZero.length) issues.push({ what: 'Объекты на слое 0 (по ЕСКД — на слоях своего типа линии)', count: onZero.length, handles: onZero.slice(0, 20) });
    if (nonGost.length) issues.push({ what: 'Слои с типами линий не по ГОСТ 2.303 (GOST_* — наши по ГОСТ)', layers: nonGost.slice(0, 20) });
    if (axisLike.length) issues.push({ what: 'Слои осевых линий со сплошной линией (нужна штрихпунктирная тонкая)', layers: axisLike });
    if (hiddenLike.length) issues.push({ what: 'Слои невидимого контура со сплошной линией (нужна штриховая)', layers: hiddenLike });
    if (weights.length) issues.push({ what: 'Нестандартные толщины линий', layers: weights.slice(0, 20) });
    if (badHeights.length) issues.push({ what: 'Высоты текста не из ряда ГОСТ 2.304 (1,8; 2,5; 3,5; 5; 7; 10; 14 мм)', heights: badHeights });
    if (emptyTexts.length) issues.push({ what: 'Пустые надписи', count: emptyTexts.length, handles: emptyTexts.slice(0, 20) });
    if (!(d.dimStyles || []).some((n) => /гост|gost|2\.307/i.test(n)) && (counts.Dimension || 0) > 0) issues.push({ what: 'Размеры без размерного стиля по ГОСТ 2.307 (текст 3,5 мм, десятичная запятая)', count: counts.Dimension });
    const hasFrame = all.some((e) => e.layer === 'Рамка') || layers.some((l) => /рамк|frame|border|формат/i.test(l.name));
    if (!hasFrame) issues.push({ what: 'Не видно рамки и основной надписи (быстрая задача «Рамка … со штампом»)' });
    return {
      title: d.title, objects: all.length, counts,
      layers: layers.length,
      issues,
      summary: issues.length ? `Найдено замечаний: ${issues.length}.` : 'Замечаний не найдено.',
    };
  }

  window.aiautocadEskd = { setup, sheet, dimensionSelected, check, FORMATS, LAYERS, TEXT_STYLE, DIM_STYLE };
})();
