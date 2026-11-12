/* AI-AutoCAD — помощник и файлы на сервере внутри программы черчения.
 *
 * Панель в браузере разговаривает с моделью через api/assistant.php, а действия
 * выполняет в самом редакторе через window.aiautocad (apps/cadcraft-web/src/bridge.rs):
 * те же методы, что у десктопного канала управления (crates/ui-egui/src/control.rs,
 * docs/control-protocol.md): команды с параметрами JSON и командная строка.
 * Чертежи хранятся на вашем сервере (api/files.php), у каждого пользователя свои.
 * Шрифты: метрически совместимые открытые шрифты из папки fonts/ и шрифты организации с сервера.
 * Оформление по ЕСКД (рамки, штамп, слои и типы линий по ГОСТ, размеры, проверка) — studio/eskd.js.
 *
 * Без сборщиков и зависимостей: подключается из index.html.
 */
(() => {
  'use strict';

  const CFG = Object.assign({
    api: 'api/assistant.php',
    files: 'api/files.php',
    fonts: 'fonts/manifest.json',
    homeUrl: '../',
    labels: 'studio/ru-labels.json',
    autosaveSeconds: 60,       // автосохранение на сервер чертежа, который там уже лежит (0 — выключить)
    maxSteps: 40,              // шагов подряд в «Сделай» по умолчанию (в панели: шестерёнка → 10…без ограничений)
    screenshotMax: 1280,       // длинная сторона снимка экрана для модели, px
    openOnStart: false,
    filesOnStart: true,
    aiMaxChars: 60000,         // сколько символов выделенных надписей (не больше) отправлять для «ИИ у выделения»
  }, window.STUDIO_CONFIG || {});
  // Страница сборки лежит в b/<номер>/ (studio/build/versioned.sh); адреса из настроек — от папки приложения.
  const fromRoot = (p) => { try { return new URL(p, window.STUDIO_ROOT || document.baseURI).href; } catch { return p; } };
  CFG.api = fromRoot(CFG.api);
  CFG.files = CFG.files ? fromRoot(CFG.files) : CFG.files;
  CFG.homeUrl = fromRoot(CFG.homeUrl || '../');
  // Редактор сам читает адрес домика из настроек.
  window.STUDIO_CONFIG = Object.assign(window.STUDIO_CONFIG || {}, { homeUrl: CFG.homeUrl });

  const READ_TOOLS = new Set(['find_commands', 'get_state', 'list_objects', 'look_at_screen', 'check_drawing']);
  // Никогда: файлы (их делает панель), интерфейс, печать и экспорт в файл, сценарии, внешние ссылки.
  const DENY = /^(ui\.|app\.|open$|qsave$|save$|saveas$|new$|qnew$|close|quit|exit|recover|recoverall|drawingrecovery|appload|script|shell|xattach|xref|xopen|attach|import|export|exportpdf|plot|publish|preview|pagesetup|document\.bytes|options|purge$|-purge|wblock|etransmit|share|sample|cutclip|copyclip|copybase|pasteclip|pasteblock|pasteorig|insertobj|imageattach|pdfattach|dwfattach|dgnattach|vbarun|vlisp|arx|netload)/i;
  // Только после подтверждения пользователя.
  const CONFIRM = /^(erase$|overkill|layer\.delete|laydel|layer\.merge|laymrg|delconstraint|explode|purge|audit|rename|layout\.delete|blockreplace)/i;
  // Команды, которые ничего не меняют в чертеже: после них «Отменить» не нужна.
  const NO_UNDO = /^(select|selectall|ai_deselect|qselect|entities|drawing\.inspect|properties$|list$|dist$|area$|id$|zoom|pan$|regen|regenall|layer$|dimstyle\.list|layerstate\.list|-?view|time|status|shapes)/;
  const fix = (v, n = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : v);

  // ------------------------------------------------------------------ мост к редактору
  const VC = () => window.aiautocad;
  const PC = {
    ready: () => !!(VC() && typeof VC().request === 'function'),
    async call(method, params) {
      if (!PC.ready()) throw new Error('Редактор ещё загружается');
      return VC().request(method, params ?? {});
    },
    exec(id, params) {
      const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
      return PC.call('engine.execute', { command: id, params: p });
    },
    // Набрать строку в командной строке, как пользователь (ответы на запросы — тоже строками).
    async type(text) {
      return PC.call('cmdline.input', { text: String(text) });
    },
  };
  // Для своих скриптов и отладки из консоли: await aiautocadStudio.exec('line', {points: [[0,0],[100,0]]})
  window.aiautocadStudio = { call: PC.call, exec: PC.exec, type: PC.type };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what + ': нет ответа'); })]);
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…[обрезано]' : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('aiautocad.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('aiautocad.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  // ------------------------------------------------------------------ русские названия
  let L = { text: {}, id: {} };
  const labelsLoaded = fetch(CFG.labels).then((r) => (r.ok ? r.json() : L)).then((j) => { L = Object.assign({ text: {}, id: {} }, j); }).catch(() => {});
  function ru(label) {
    if (!label) return '';
    if (L.text[label]) return L.text[label];
    const bare = label.replace(/(…|\.\.\.)$/, '');
    if (bare !== label && L.text[bare]) return L.text[bare] + '…';
    if (L.text[label + '...']) return L.text[label + '...'].replace(/(…|\.\.\.)$/, '');
    return label;
  }
  const menuOf = (c) => (Array.isArray(c.menu) ? c.menu.slice(0, -1) : String(c.location || c.menu || '').split('›').map((x) => x.trim()).filter(Boolean));
  const ruName = (c) => L.id[c.id] || ru(c.label);
  const ruPath = (c) => [...menuOf(c).map(ru), ruName(c)].join(' › ');

  // ------------------------------------------------------------------ поиск команд
  let catalog = null;
  let catalogAt = 0;
  async function commands() {
    if (!catalog || Date.now() - catalogAt > 30000) {
      const r = await PC.call('engine.commands');
      catalog = Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : []);
      catalogAt = Date.now();
    }
    return catalog;
  }
  // Частые просьбы → слова, которыми такие команды называются (имена команд AutoCAD).
  const SYN = [
    [/отрез|лини[яию]/, 'line'], [/полилин/, 'pline polyline'], [/прямоуг/, 'rectang rectangle'], [/окружн|круг/, 'circle'], [/дуг/, 'arc'],
    [/многоуг/, 'polygon'], [/эллипс/, 'ellipse'], [/сплайн/, 'spline'], [/точк/, 'point'], [/штрих(овк|уй)/, 'hatch'], [/облак/, 'revcloud'],
    [/текст|надпис/, 'text mtext'], [/многострочн/, 'mtext'], [/таблиц/, 'table'], [/выноск/, 'mleader leader'],
    [/размер/, 'dim dimlinear dimaligned dimradius dimdiameter dimangular qdim'], [/радиус/, 'dimradius radius'], [/диаметр/, 'dimdiameter'], [/угл/, 'dimangular angular'],
    [/цепочк|продолж/, 'dimcontinue'], [/от базы|базов/, 'dimbaseline'], [/размерн\S* стил/, 'dimstyle'], [/текстов\S* стил|шрифт/, 'style text style'],
    [/сло[йияе]/, 'layer'], [/тип\S* лини/, 'linetype ltscale'], [/толщин|вес лини/, 'lweight lineweight'], [/цвет/, 'color properties'],
    [/перемест|сдвин/, 'move'], [/копир/, 'copy'], [/поверн/, 'rotate'], [/масштаб/, 'scale zoom'], [/зеркал/, 'mirror'], [/подобн|смещ|эквидист/, 'offset'],
    [/обреж|обрез/, 'trim'], [/удлин/, 'extend'], [/сопряж|скругл/, 'fillet'], [/фаск/, 'chamfer'], [/массив/, 'array arrayrect arraypolar'], [/разорв/, 'break'],
    [/соедин|объедин/, 'join'], [/расчлен|разбить/, 'explode'], [/удал|стер/, 'erase'], [/растян/, 'stretch'], [/выров/, 'align'],
    [/блок/, 'block insert'], [/атрибут/, 'attdef attedit'], [/групп/, 'group'], [/выдел|выбер/, 'select selectall qselect'],
    [/лист|компоновк/, 'layout'], [/видов\S* экран/, 'mview vports'], [/печат|плот/, 'plot pagesetup'], [/предел/, 'limits'], [/единиц/, 'units'],
    [/расстоян|измер/, 'dist measuregeom'], [/площад/, 'area'], [/свойств/, 'properties'], [/дубликат|наложен/, 'overkill'], [/провер|ошибк/, 'audit'],
    [/отмен/, 'undo u'], [/покажи все|границ|увелич|уменьш/, 'zoom'], [/сетк|шаг/, 'grid snap dsettings'], [/орто/, 'ortho'], [/привязк/, 'osnap'],
  ];
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  async function findCommands(query) {
    const all = await commands();
    await labelsLoaded;
    const q = norm(query).trim();
    if (!q) return { results: [], hint: 'Пустой запрос' };
    const terms = new Set(q.split(/[^\p{L}\p{N}._-]+/u).filter((t) => t.length > 1));
    for (const [re, words] of SYN) if (re.test(q)) words.split(' ').forEach((w) => terms.add(w));
    const scored = [];
    for (const c of all) {
      if (DENY.test(c.id) || c.ui) continue;
      const name = norm(ruName(c));
      const en = norm(c.label);
      const path = norm(menuOf(c).map(ru).join(' ') + ' ' + menuOf(c).join(' '));
      const id = norm(c.id);
      const aliases = (c.aliases || []).map(norm);
      let s = 0;
      if (name === q || en === q || id === q || aliases.includes(q)) s += 20;
      else if (name.includes(q) || en.includes(q)) s += 10;
      for (const t of terms) {
        if (id === t || aliases.includes(t)) s += 9;
        if (name.includes(t)) s += name.startsWith(t) ? 7 : 5;
        if (en.includes(t)) s += en.startsWith(t) ? 6 : 4;
        if (id.includes(t)) s += 3;
        if (path.includes(t)) s += 1;
      }
      if (s > 0) scored.push([s + (c.params && c.params !== '{}' ? 1 : 0), c]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const results = scored.slice(0, 10).map(([, c]) => ({
      id: c.id,
      name: ruName(c),
      menu: ruPath(c),
      aliases: c.aliases && c.aliases.length ? c.aliases.slice(0, 4).join(', ') : undefined,
      params: c.params && c.params !== '{}' ? clip(String(c.params), 700) : undefined,
    }));
    return results.length ? { results } : { results: [], hint: 'Ничего не найдено. Попробуй другие слова, лучше английские имена команд AutoCAD: line, pline, circle, trim, offset, dimlinear, layer, mtext.' };
  }

  // ------------------------------------------------------------------ состояние и снимок экрана
  const P = (v) => (Array.isArray(v) ? [fix(v[0]), fix(v[1])] : v && typeof v === 'object' ? [fix(v.x), fix(v.y)] : v);
  // Объект кратко: тип, слой, главная геометрия в единицах чертежа (мм).
  function objectSummary(e) {
    const g = e.geometry || {};
    const o = { handle: e.handle, type: e.type, layer: e.layer };
    if (e.color && e.color !== 'ByLayer') o.color = e.color;
    switch (g.type) {
      case 'line': o.from = P(g.a); o.to = P(g.b); o.length = fix(Math.hypot((g.b.x - g.a.x), (g.b.y - g.a.y))); break;
      case 'circle': o.center = P(g.center); o.radius = fix(g.radius); break;
      case 'arc': o.center = P(g.center); o.radius = fix(g.radius); o.startDeg = fix(g.start * 180 / Math.PI, 1); o.endDeg = fix(g.end * 180 / Math.PI, 1); break;
      case 'lwPolyline': o.closed = !!g.closed; o.vertices = (g.vertices || []).slice(0, 24).map((v) => P(v.p)); if ((g.vertices || []).length > 24) o.moreVertices = g.vertices.length - 24; if ((g.vertices || []).some((v) => v.bulge)) o.hasArcs = true; break;
      case 'text': o.text = clip(String(g.value || ''), 200); o.at = P(g.insert); o.height = fix(g.height); if (g.style && g.style !== 'Standard') o.style = g.style; break;
      case 'mText': o.text = clip(plainMtext(g.contents), 300); o.at = P(g.insert); o.height = fix(g.height); if (g.width) o.width = fix(g.width); if (g.style && g.style !== 'Standard') o.style = g.style; break;
      case 'insert': o.block = g.name; o.at = P(g.insert); break;
      case 'dimension': if (g.measurement) o.measurement = fix(g.measurement); if (g.text) o.textOverride = g.text; break;
      default: break;
    }
    return o;
  }
  // Текст MTEXT без кодов оформления: \P — новый абзац, {\f…;…} и \H…; — убираются.
  function plainMtext(s) {
    return String(s || '')
      .replace(/\\P/g, '\n')
      .replace(/\\[ACcFfHhLlOoQqTtWw][^;\\{}]*;/g, '')
      .replace(/\\S([^;]*)[#^/]([^;]*);/g, '$1/$2')
      .replace(/\\[LlOoKk]/g, '')
      .replace(/[{}]/g, '')
      .replace(/\\~/g, ' ')
      .replace(/\\\\/g, '\\');
  }
  // Текущий чертёж: имя, сохранён ли, единицы, границы, слои, типы линий, стили, выделенное, что на чертеже.
  async function snapshot() {
    const state = {};
    try {
      const d = await PC.call('drawing.inspect', { entities: false });
      state.title = d.title;
      state.unsaved = !!d.dirty;
      state.onServer = Files.isServer(d.title) || Files.isServer(d.path);
      state.space = d.space;
      state.objects = d.entityCount;
      state.counts = d.counts;
      if (Array.isArray(d.extents)) state.extentsMm = d.extents.map(P);
      state.currentLayer = d.currentLayer;
      state.layers = (d.layers || []).slice(0, 40).map((l) => ({ name: l.name, color: l.color, linetype: l.linetype, ...(l.on === false ? { off: true } : {}), ...(l.frozen ? { frozen: true } : {}), ...(l.locked ? { locked: true } : {}) }));
      if ((d.layers || []).length > 40) state.moreLayers = d.layers.length - 40;
      state.linetypes = (d.linetypes || []).slice(0, 30);
      state.textStyles = (d.textStyles || []).slice(0, 20);
      state.dimStyles = (d.dimStyles || []).slice(0, 20);
      if ((d.blocks || []).length) state.blocks = d.blocks.slice(0, 30);
      if ((d.layouts || []).length > 1) state.layouts = d.layouts;
      state.view = d.view ? { center: P(d.view.center), height: fix(d.view.height) } : undefined;
      if (d.readNotes && d.readNotes.length) state.readNotes = d.readNotes.slice(0, 5);
      const sel = Array.isArray(d.selection) ? d.selection : [];
      if (sel.length) {
        state.selectedCount = sel.length;
        try {
          const r = await PC.exec('entities', { selected: true, limit: 20 });
          state.selected = (r.entities || []).map(objectSummary);
        } catch { state.selected = sel.slice(0, 20); }
      }
      try {
        // getvar ничего не меняет (UNITS без параметров записал бы шаг отмены).
        const u = await PC.exec('getvar', { name: 'INSUNITS' });
        const v = u && u.value;
        if (v != null) state.units = Number(v) === 4 ? 'мм' : `INSUNITS=${v}`;
      } catch { /* не важно */ }
      try {
        const cl = await PC.call('cmdline.state');
        if (cl && cl.running) state.runningCommand = { id: cl.running, prompt: cl.prompt, keywords: cl.keywords };
      } catch { /* не важно */ }
    } catch (e) {
      state.note = 'Чертёж не открыт (вкладка «Начало»). Новый чертёж: Файл › Создать (Ctrl+N).';
    }
    return state;
  }
  // Объекты чертежа: все или по фильтру (тип, слой, только выделенные, в рамке), страницами.
  async function listObjects(a) {
    const p = { limit: Math.max(1, Math.min(200, parseInt(a.limit, 10) || 80)), offset: Math.max(0, parseInt(a.offset, 10) || 0) };
    if (a.type) p.type = String(a.type);
    if (a.layer) p.layer = String(a.layer);
    if (a.selected) p.selected = true;
    if (Array.isArray(a.window) && a.window.length === 2) p.window = a.window;
    const r = await PC.exec('entities', p);
    return { count: r.count, returned: r.returned, offset: r.offset, objects: (r.entities || []).map(objectSummary) };
  }

  function downscale(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, CFG.screenshotMax / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.75).split(',')[1]);
      };
      img.onerror = () => reject(new Error('не удалось прочитать снимок'));
      img.src = src;
    });
  }
  async function screenshot() {
    if (!PC.ready()) return null;
    try {
      const r = await withTimeout(VC().screenshot(), 9000, 'снимок');
      const b64 = r && (r.data || r.pngBase64 || r.png);
      if (typeof b64 === 'string' && b64.length > 100) return await downscale('data:image/png;base64,' + b64);
    } catch { /* ниже */ }
    return null;
  }

  // ------------------------------------------------------------------ интерфейс
  const ICON = {
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-9 9H5v-6z"/><path d="M12.5 5.5l6 6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2.2a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16.5" cy="10.5" r="1.2"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    // Мозг — контур из набора Tabler Icons (MIT), нарисованный градиентом #st-brain-grad.
    brain: '<svg class="st-brain-svg" viewBox="0 0 24 24" fill="none" stroke="url(#st-brain-grad)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8"/><path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8"/><path d="M17.5 16a3.5 3.5 0 0 0 0 -7h-.5"/><path d="M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0"/><path d="M6.5 16a3.5 3.5 0 0 1 0 -7h.5"/><path d="M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3l-8 11h6l-1 7 8-11h-6z"/></svg>',
  };
  // Живой контур: мозг градиентом и три точки на орбите, пока помощник работает.
  const BRAIN = `${ICON.brain}<b class="st-orbit" aria-hidden="true"><i></i><i></i><i></i></b>`;

  const root = document.createElement('div');
  root.id = 'studio-root';
  root.dataset.theme = 'light';
  root.innerHTML = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="st-brain-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fa2ff"/><stop offset=".55" stop-color="#9b7cf0"/><stop offset="1" stop-color="#ff77c6"/></linearGradient></defs></svg>
    <div class="st-veil" aria-hidden="true"></div>
    <div class="st-drop" aria-hidden="true"><span>Отпустите, чтобы открыть в редакторе</span></div>
    <aside class="st-panel" aria-label="Помощник">
      <header class="st-head">
        <div class="st-logo st-brain st-raised-sm" aria-hidden="true">${BRAIN}</div>
        <div class="st-title"><b>Помощник</b><small data-ref="sub">Загрузка редактора…</small></div>
        <button class="st-icon-btn" data-ref="galleryBtn" title="Быстрые задачи: рамка ЕСКД со штампом, слои ГОСТ, размеры, проверка, PDF…" aria-label="Быстрые задачи">${ICON.layout}</button>
        <button class="st-icon-btn" data-ref="filesBtn" title="Мои файлы (на сервере)" aria-label="Мои файлы">${ICON.folder}</button>
        <button class="st-icon-btn" data-ref="barBtn" title="Быстрая строка (Ctrl+Shift+Пробел)" aria-label="Быстрая строка">${ICON.bolt}</button>
        <div class="st-theme-wrap">
          <button class="st-icon-btn" data-ref="theme" title="Тема оформления" aria-label="Тема оформления" aria-haspopup="menu" aria-expanded="false">${ICON.palette}</button>
          <div class="st-theme-menu" data-ref="themeMenu" role="menu" hidden></div>
        </div>
        <button class="st-icon-btn" data-ref="hide" title="Свернуть панель" aria-label="Свернуть панель">${ICON.close}</button>
      </header>
      <div class="st-seg st-pressed" role="group" aria-label="Режим помощника">
        <button data-mode="advice" aria-pressed="true">${ICON.bulb}Совет</button>
        <button data-mode="act" aria-pressed="false">${ICON.hand}Сделай</button>
      </div>
      <div class="st-mode-hint" data-ref="hint"></div>
      <div class="st-log" data-ref="log" role="log" aria-live="polite"></div>
      <div class="st-composer">
        <div class="st-input st-pressed">
          <button class="st-icon-btn" data-ref="eye" aria-pressed="true" title="Показывать помощнику экран" aria-label="Показывать помощнику экран">${ICON.eye}</button>
          <textarea data-ref="input" rows="1" placeholder="Спросите или попросите…" aria-label="Сообщение помощнику"></textarea>
          <button class="st-send" data-ref="send" title="Отправить (Enter)" aria-label="Отправить">${ICON.send}</button>
        </div>
        <div class="st-foot"><span>Ctrl+Z — отменить</span><span class="st-agent-wrap"><button data-ref="agentBtn" title="Сколько шагов подряд делать и спрашивать ли перед удалением" aria-haspopup="menu" aria-expanded="false">${ICON.gear}Настройки</button><span class="st-theme-menu st-agent-menu" data-ref="agentMenu" role="menu" hidden></span></span><button data-ref="clear">Новый разговор</button></div>
      </div>
    </aside>
    <div class="st-files" data-ref="files" role="dialog" aria-modal="true" aria-label="Мои файлы" hidden>
      <div class="st-files-box">
        <header class="st-files-head">
          <b>Мои чертежи</b><small data-ref="filesWho"></small>
          <button class="st-icon-btn" data-ref="filesClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-files-tools">
          <input data-ref="filesSearch" type="search" placeholder="Поиск по имени" aria-label="Поиск по имени">
          <button class="st-mini" data-ref="filesNew">Новый чертёж</button>
          <button class="st-mini" data-ref="filesUpload" title=".dwg, .dxf, .dwt">С компьютера…</button>
        </div>
        <div class="st-files-list" data-ref="filesList"></div>
        <footer class="st-files-foot">
          <span data-ref="filesCurrent"></span>
          <button class="st-mini" data-ref="filesSaveAs">Сохранить как…</button>
          <button class="st-mini primary" data-ref="filesSave">Сохранить</button>
        </footer>
      </div>
    </div>
    <div class="st-files st-gallery" data-ref="gallery" role="dialog" aria-modal="true" aria-label="Быстрые задачи" hidden>
      <div class="st-files-box st-gallery-box">
        <header class="st-files-head">
          <b>Быстрые задачи</b>
          <small>В одно нажатие. Действуют на открытый чертёж; всё отменяется Ctrl+Z.</small>
          <button class="st-icon-btn" data-ref="galleryClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-gpane"><div class="st-gtasks" data-ref="gTasks"></div></div>
      </div>
    </div>
    <div class="st-ask" data-ref="ask" role="dialog" aria-modal="true" hidden>
      <form class="st-ask-box">
        <b data-ref="askTitle"></b>
        <input data-ref="askInput" type="text" maxlength="120">
        <small data-ref="askNote"></small>
        <div class="st-row"><button type="button" class="st-mini" data-ref="askCancel">Отмена</button><button type="submit" class="st-mini primary" data-ref="askOk">OK</button></div>
      </form>
    </div>
    <button class="st-fab st-brain" data-ref="fab" title="Помощник" aria-label="Открыть помощника">${BRAIN}<span class="st-badge" aria-hidden="true"></span></button>
    <div class="st-bar" data-ref="bar" role="dialog" aria-label="Быстрая строка помощника">
      <div class="st-bar-answer" data-ref="barAnswer"></div>
      <div class="st-bar-row">
        <button class="st-bar-mode" data-ref="barMode" title="Режим: Совет или Сделай"></button>
        <input data-ref="barInput" type="text" placeholder="Что написать или поправить? Enter — отправить, Esc — закрыть" aria-label="Запрос помощнику">
        <button class="st-send" data-ref="barSend" aria-label="Отправить">${ICON.send}</button>
      </div>
    </div>`;
  const $ = (name) => root.querySelector(`[data-ref="${name}"]`);
  const log = $('log');
  const input = $('input');

  // Клавиши, набранные в панели, не должны доходить до редактора (иначе «B» выберет кисть).
  for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  let mode = store.get('mode', 'advice');
  let attachScreen = store.get('eye', true);
  let busy = false;
  let stopRequested = false;
  let convo = [];

  const HINTS = {
    advice: 'Объясняю и подсказываю, ничего не меняю в чертеже.',
    act: 'Черчу сам: линии и контуры, размеры, надписи, слои и типы линий, рамку и штамп по ЕСКД. Всё отменяется Ctrl+Z.',
  };
  // Модель видит всю переписку. Если раньше она писала «я в режиме Совет», то по инерции продолжает
  // так отвечать и после переключения. Поэтому смена режима отмечается прямо в разговоре,
  // а каждое сообщение пользователя несёт текущий режим.
  const MODE_NOTE = {
    act: '[Режим переключён на «Сделай». Теперь ты сам выполняешь просьбы инструментами (run_command, command_line, eskd_sheet…). Всё, что ты раньше писал про режим «Совет», больше не действует.]',
    advice: '[Режим переключён на «Совет». Теперь только объясняй и подсказывай, ничего не меняй в чертеже.]',
  };
  const MODE_TAG = {
    act: '[Режим сейчас: «Сделай» — выполни это сам, инструментами]',
    advice: '[Режим сейчас: «Совет» — объясни, как сделать, ничего не меняя]',
  };
  function setMode(m) {
    const next = m === 'act' ? 'act' : 'advice';
    if (next !== mode && convo.length) convo.push({ role: 'user', content: MODE_NOTE[next] });
    mode = next;
    store.set('mode', mode);
    root.querySelectorAll('.st-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('hint').textContent = HINTS[mode];
    const bm = root.querySelector('[data-ref="barMode"]');
    if (bm) bm.textContent = mode === 'act' ? 'Сделай' : 'Совет';
  }
  function setEye(on) {
    attachScreen = !!on;
    store.set('eye', attachScreen);
    $('eye').setAttribute('aria-pressed', String(attachScreen));
    $('eye').title = attachScreen ? 'Помощник видит экран' : 'Помощник не видит экран';
  }
  function setOpen(open) {
    root.classList.toggle('open', open);
    document.body.classList.toggle('studio-open', open);
    setTimeout(syncBackdrop, 60);
    setTimeout(syncBackdrop, 400);
    store.set('open', open);
    // eframe подхватывает новый размер canvas на следующем кадре
    window.dispatchEvent(new Event('resize'));
    if (open) { setTimeout(() => input.focus(), 200); root.classList.remove('has-hints'); }
  }
  function setBusy(on) {
    busy = on;
    root.classList.toggle('busy', on);
    $('send').innerHTML = on ? ICON.stop : ICON.send;
    $('send').title = on ? 'Остановить' : 'Отправить (Enter)';
  }
  function scroll() { log.scrollTop = log.scrollHeight; }

  function format(text) {
    // Строки списка «- …» / «* …» — с точкой; короткая строка, оканчивающаяся двоеточием, — заголовок.
    text = text.trim().split('\n').map((line) => {
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (li) return '\u0001' + (/^\s*\d/.test(line) ? line.trim().match(/^\d+[.)]/)[0] + ' ' : '• ') + li[1] + '\u0002';
      const head = line.match(/^\s*(?:#{1,4}\s*)?\**([^*:]{2,60}):\**\s*$/);
      if (head) return '\u0003' + head[1] + ':\u0004';
      return line.replace(/^#{1,4}\s+/, '');
    }).join('\n').replace(/\u0002\n/g, '\u0002');  // пункт списка — блок: перенос после него лишний
    let h = esc(text);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/\((Ctrl|Shift|Alt|Cmd|⌘|⇧|⌥)([^)\n]{0,24})\)/g, '(<kbd>$1$2</kbd>)');
    // «Изображение › Коррекция › Кривые» — путь в меню
    // Сегменты — слова через одиночные пробелы: конечный пробел не должен «съедать» разделитель.
    const C = '[^\\s›«»"():.,!?;<>&]';
    const word = `${C}+`;
    const path = new RegExp(`([А-ЯЁA-Z]${C}*(?: ${word}){0,2}(?: › ${word}(?: ${word}){0,3}){1,4})`, 'g');
    h = h.replace(path, '<span class="st-path">$1</span>');
    h = h.replace(/\u0001/g, '<span class="st-li">').replace(/\u0002/g, '</span>')
      .replace(/\u0003/g, '<span class="st-h">').replace(/\u0004/g, '</span>');
    return h;
  }
  function add(el) { log.querySelector('.st-empty')?.remove(); log.appendChild(el); scroll(); return el; }
  function msg(cls, html) { const d = document.createElement('div'); d.className = 'st-msg ' + cls; d.innerHTML = html; return add(d); }
  function typing(on) {
    log.querySelector('.st-typing')?.remove();
    if (on) { const t = document.createElement('div'); t.className = 'st-typing st-raised-sm'; t.innerHTML = '<i></i><i></i><i></i>'; add(t); }
  }

  const ACTION_TEXT = {
    find_commands: (a) => ['Ищу команду', a.query],
    get_state: () => ['Смотрю чертёж', ''],
    list_objects: (a) => ['Смотрю объекты', [a.type, a.layer ? 'слой ' + a.layer : '', a.selected ? 'выделенные' : ''].filter(Boolean).join(', ')],
    check_drawing: () => ['Проверяю чертёж', 'контуры, слои, типы линий'],
    eskd_sheet: (a) => ['Черчу рамку со штампом', [a.format || 'A4', a.orientation === 'landscape' ? 'горизонтально' : ''].filter(Boolean).join(', ')],
    eskd_setup: () => ['Создаю слои и типы линий по ГОСТ', ''],
    dimension_selected: () => ['Проставляю размеры', 'у выделенного'],
    look_at_screen: () => ['Смотрю на экран', ''],
    undo: (a) => ['Отменяю', `${a.steps || 1} шаг(а)`],
  };
  function card(name, args, label) {
    const d = document.createElement('div');
    const [title, detail] = label || (ACTION_TEXT[name] ? ACTION_TEXT[name](args) : [name, '']);
    d.className = 'st-act' + (READ_TOOLS.has(name) ? ' read' : '');
    d.innerHTML = `<span class="st-dot"></span><div class="st-act-text"><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
    return add(d);
  }
  function cardResult(d, ok, error, undoable) {
    if (!ok) {
      d.classList.add('fail');
      const s = d.querySelector('small') || d.querySelector('.st-act-text').appendChild(document.createElement('small'));
      s.textContent = error;
      return;
    }
    if (undoable) {
      const b = document.createElement('button');
      b.className = 'st-mini';
      b.textContent = 'Отменить';
      b.onclick = async () => {
        b.disabled = true;
        const steps = typeof undoable === 'number' ? undoable : 1;
        try { await PC.exec('undo', { count: steps }); b.textContent = 'Отменено'; } catch (e) { b.textContent = 'Не вышло'; b.title = e.message; }
      };
      d.appendChild(b);
    }
  }
  // ------------------------------------------------------------------ настройки помощника
  // Сколько шагов подряд делать в «Сделай» (потом — кнопка «Продолжить») и спрашивать ли перед
  // удалением, закрытием, сбросом. Хранятся в этом браузере; меню — «Настройки» внизу панели.
  const STEP_CHOICES = [10, 25, 40, 100, 0]; // 0 — без ограничений
  const stepSetting = () => { const v = Number(store.get('agentSteps', CFG.maxSteps)); return Number.isFinite(v) && v >= 0 ? v : CFG.maxSteps; };
  const agentSteps = () => (stepSetting() > 0 ? stepSetting() : Infinity);
  const askBeforeRisky = () => store.get('agentConfirm', true) !== false;
  function renderAgentMenu() {
    const menu = $('agentMenu');
    if (!menu) return;
    const cur = stepSetting();
    menu.innerHTML = '<div class="st-menu-title">Шагов подряд в «Сделай»</div>'
      + STEP_CHOICES.map((n) => `<button role="menuitemradio" aria-checked="${n === cur}" data-steps="${n}">${n ? n : 'Без ограничений'}</button>`).join('')
      + '<hr><label class="st-menu-check"><input type="checkbox" data-k="agentConfirm"' + (askBeforeRisky() ? ' checked' : '') + '><span>Спрашивать перед удалением, закрытием и сбросом</span></label>'
      + '<label class="st-menu-check"><input type="checkbox" data-k="agentLook"' + (store.get('agentLook', true) ? ' checked' : '') + '><span>Смотреть на результат после каждой серии шагов (если включён «глаз»)</span></label>';
    menu.querySelectorAll('[data-steps]').forEach((b) => { b.onclick = () => { store.set('agentSteps', Number(b.dataset.steps)); renderAgentMenu(); }; });
    menu.querySelectorAll('input[data-k]').forEach((c) => { c.onchange = () => store.set(c.dataset.k, c.checked); });
  }
  function toggleAgentMenu(open) {
    const menu = $('agentMenu');
    if (!menu) return;
    const show = open == null ? menu.hidden : open;
    if (show) renderAgentMenu();
    menu.hidden = !show;
    $('agentBtn').setAttribute('aria-expanded', String(show));
  }
  function initAgentMenu() {
    const btn = $('agentBtn');
    if (!btn) return;
    btn.onclick = (e) => { e.stopPropagation(); toggleAgentMenu(); };
    document.addEventListener('pointerdown', (e) => {
      const menu = $('agentMenu');
      if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) toggleAgentMenu(false);
    }, true);
  }
  let allowAllThisTurn = false;
  let autoAllowNoted = false;
  function confirmAction(text) {
    if (!askBeforeRisky() || allowAllThisTurn) {
      if (!autoAllowNoted) {
        autoAllowNoted = true;
        msg('note', 'Необратимые действия выполняю без вопроса — так выбрано. Вернуть вопросы: «Настройки» внизу панели. Отменить шаг — Ctrl+Z.');
      }
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const d = document.createElement('div');
      d.className = 'st-confirm st-raised';
      d.innerHTML = `<p>${esc(text)}</p>`
        + '<label class="st-confirm-check"><input type="checkbox"> Больше не спрашивать (вернуть — «Настройки» внизу панели)</label>'
        + '<div class="st-row"><button class="st-mini danger" data-a="no">Не надо</button>'
        + '<button class="st-mini" data-a="all" title="Не спрашивать до конца этой просьбы">Разрешать всё в этой задаче</button>'
        + '<button class="st-mini" data-a="yes">Разрешить</button></div>';
      add(d);
      d.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          const yes = b.dataset.a !== 'no';
          if (yes && d.querySelector('input').checked) store.set('agentConfirm', false);
          if (b.dataset.a === 'all') allowAllThisTurn = true;
          d.remove();
          resolve(yes);
        };
      });
    });
  }

  function showEmpty() {
    log.innerHTML = `<div class="st-empty">
      <h3>Чем помочь?</h3>
      <p>Спросите, где найти команду в AI-AutoCAD, или попросите начертить, оформить по ЕСКД или проверить чертёж за вас.</p>
      <button class="st-mini primary st-start-tpl">Быстрые задачи</button>
      <div class="st-chips">
        <button class="st-chip" data-act="1">Начерти рамку A4 со штампом</button>
        <button class="st-chip" data-act="1">Проставь размеры у выделенного</button>
        <button class="st-chip" data-act="1">Проверь чертёж: незамкнутые контуры, слои, типы линий</button>
        <button class="st-chip" data-act="1">Начерти пластину 120×80 мм с четырьмя отверстиями Ø10 по углам, отступ 15 мм: </button>
        <button class="st-chip">Как задать масштаб 1:2 на листе по ГОСТ 2.302?</button>
      </div></div>`;
    const st = log.querySelector('.st-start-tpl');
    if (st) st.onclick = () => Gallery.show(true);
    log.querySelectorAll('.st-chip').forEach((c) => {
      c.onclick = () => {
        if (c.dataset.act) setMode('act');
        input.value = c.textContent;
        if (/:\s*$/.test(c.textContent)) { autosize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); return; }
        send();
      };
    });
  }

  // ------------------------------------------------------------------ инструменты для модели
  async function commandById(id) {
    const c = (await commands()).find((x) => x.id === id);
    if (!c) throw new Error(`Нет команды «${id}». Найди нужную через find_commands (id — имя команды AutoCAD строчными буквами: line, circle, dimlinear…).`);
    if (DENY.test(id) || c.ui) throw new Error('Эту команду помощнику выполнять нельзя (файлы, печать, интерфейс и служебное делает панель или сам пользователь).');
    return c;
  }
  const short = (v) => (v === undefined || v === null ? { ok: true } : { ok: true, result: v });
  const trimJson = (v, n) => JSON.parse(clip(JSON.stringify(v), n).replace(/…\[обрезано\]$/, '') || 'null');
  const ESKD = () => window.aiautocadEskd;

  // Строка в командной строке: вывод команды и её текущий запрос.
  async function commandLine(text) {
    const lines = String(text || '').split('\n').map((l) => l.trimEnd()).filter((l, i, all) => l || i < all.length - 1);
    if (!lines.length) throw new Error('Пустая строка');
    if (lines.length > 200) throw new Error('Не больше 200 строк за раз');
    const output = [];
    let last = null;
    for (const line of lines) {
      const first = line.trim().split(/\s+/)[0] || '';
      if (first && DENY.test(first.replace(/^[_.-]+/, '').toLowerCase()) && !(last && last.running)) {
        throw new Error(`Команду ${first} помощнику набирать нельзя (файлы, печать, интерфейс — это делает панель или пользователь).`);
      }
      last = await PC.type(line);
      if (last && Array.isArray(last.output)) output.push(...last.output);
      if (last && last.error) break;
    }
    return { output: clip(output.join('\n'), 3000), prompt: last && last.prompt, running: last && last.running, keywords: last && last.keywords, error: last && last.error };
  }

  async function runTool(name, args) {
    if (mode !== 'act' && !READ_TOOLS.has(name)) {
      return { ok: false, error: 'Сейчас режим «Совет»: действия выключены. Объясни пользователю, как сделать это самому, или предложи переключиться в «Сделай».' };
    }
    switch (name) {
      case 'find_commands': {
        const d = card(name, args);
        const r = await findCommands(String(args.query || ''));
        cardResult(d, true);
        return r;
      }
      case 'get_state': {
        card(name, args);
        return await snapshot();
      }
      case 'list_objects': {
        const d = card(name, args);
        try { const r = await listObjects(args); cardResult(d, true); return short(trimJson(r, 9000)); } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'look_at_screen': {
        const d = card(name, args);
        const img = await screenshot();
        cardResult(d, !!img, 'Снимок не получился');
        return img ? { ok: true, note: 'Снимок приложен следующим сообщением.', __image: img } : { ok: false, error: 'Снимок экрана не получился' };
      }
      case 'check_drawing': {
        const d = card(name, args);
        if (!ESKD()) { cardResult(d, false, 'нет модуля ЕСКД'); return { ok: false, error: 'Проверка недоступна в этой сборке' }; }
        try { const r = await ESKD().check(PC); cardResult(d, true); return short(trimJson(r, 9000)); } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'run_command': {
        const c = await commandById(String(args.id || '').trim().toLowerCase());
        if (CONFIRM.test(c.id) && !(await confirmAction(`Помощник хочет выполнить «${ruPath(c)}» (${c.id.toUpperCase()}). Разрешить?`))) {
          card(name, args, ['Пропущено пользователем', ruPath(c)]).classList.add('fail');
          return { ok: false, error: 'Пользователь не разрешил это действие. Не повторяй его, спроси, как поступить.' };
        }
        const d = card(name, args, ['Выполняю', ruPath(c) + ' · ' + c.id.toUpperCase()]);
        root.classList.add('acting');
        try {
          const r = await PC.exec(c.id, args.params && typeof args.params === 'object' ? args.params : null);
          cardResult(d, true, '', !NO_UNDO.test(c.id) && !c.noundo);
          return short(r && typeof r === 'object' ? trimJson(r, 3000) : r);
        } catch (e) {
          cardResult(d, false, e.message);
          return { ok: false, error: e.message, params_doc: c.params ? clip(String(c.params), 900) : undefined };
        } finally {
          root.classList.remove('acting');
        }
      }
      case 'command_line': {
        const text = String(args.text || '');
        const d = card(name, args, ['Набираю в командной строке', clip(text.replace(/\n/g, ' ⏎ '), 90)]);
        root.classList.add('acting');
        try {
          const r = await commandLine(text);
          if (r.error) { cardResult(d, false, r.error); return { ok: false, ...r }; }
          cardResult(d, true, '', true);
          return { ok: true, ...r };
        } catch (e) {
          cardResult(d, false, e.message);
          return { ok: false, error: e.message };
        } finally {
          root.classList.remove('acting');
        }
      }
      case 'eskd_sheet':
      case 'eskd_setup':
      case 'dimension_selected': {
        const d = card(name, args);
        if (!ESKD()) { cardResult(d, false, 'нет модуля ЕСКД'); return { ok: false, error: 'Недоступно в этой сборке' }; }
        root.classList.add('acting');
        try {
          const fn = name === 'eskd_sheet' ? 'sheet' : name === 'eskd_setup' ? 'setup' : 'dimensionSelected';
          const r = await ESKD()[fn](PC, args || {});
          cardResult(d, true, '', r && r.steps ? r.steps : true);
          if (r) delete r.steps;
          return { ok: true, ...(r || {}) };
        } catch (e) {
          cardResult(d, false, e.message);
          return { ok: false, error: e.message };
        } finally {
          root.classList.remove('acting');
        }
      }
      case 'undo': {
        const n = Math.max(1, Math.min(50, parseInt(args.steps, 10) || 1));
        const d = card(name, { steps: n });
        try { await PC.exec('undo', { count: n }); cardResult(d, true); return { ok: true }; } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      default:
        return { ok: false, error: `Инструмента «${name}» нет. Доступны только: ${TOOL_NAMES.join(', ')}. Кликов по координатам нет: найди команду через find_commands и выполни её run_command или command_line.` };
    }
  }

  // Модель иногда пишет вызов инструмента текстом вместо tool_calls — подхватываем его.
  const TOOL_NAMES = ['find_commands', 'get_state', 'list_objects', 'look_at_screen', 'check_drawing', 'run_command', 'command_line', 'eskd_sheet', 'eskd_setup', 'dimension_selected', 'undo'];

  // ------------------------------------------------------------------ разговор с моделью
  // Память разговора. У модели ограниченный контекст (CTX токенов, сервер сообщает его при запуске);
  // если история не влезает, сервер модели молча отрезает её начало — вместе с задачей, и помощник
  // начинает ходить по кругу. Поэтому прошлые просьбы уходят сжато (просьба и итог, без шагов и
  // снимков), текущая — целиком; если и она не влезает, сначала сокращаются старые результаты шагов,
  // потом выпадают самые ранние шаги, но сама просьба остаётся всегда.
  let CTX = 32768;
  let turnStart = 0;
  const AUTO_STATE = /\n\n\[Состояние [^\]]*— автоматически\][\s\S]*$/;
  const AUTO_MSG = /^\[(Снимок экрана|Состояние)[^\]]*автоматически\]/;
  const plainText = (t) => String(t || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<?function=[\w.-]+>[\s\S]*?(<\/function>|$)/g, '').replace(/<\/?tool_call>/g, '').trim();
  const sizeOf = (m) => String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + (m.images ? m.images.length * 3500 : 0);
  function outgoing() {
    const start = Math.min(Math.max(0, turnStart), convo.length);
    const older = [];
    for (const m of convo.slice(0, start)) {
      if (m.role === 'tool') continue;
      if (m.role === 'user') {
        if (AUTO_MSG.test(String(m.content || ''))) continue;
        older.push({ role: 'user', content: clip(String(m.content || '').replace(AUTO_STATE, ''), 1500) });
      } else if (m.role === 'assistant') {
        const text = plainText(m.content);
        const names = [...new Set((m.tool_calls || []).map((c) => c.function && c.function.name).filter(Boolean))];
        const line = text ? clip(text, 1200) : (names.length ? '[Выполнено: ' + names.join(', ') + ']' : '');
        if (!line) continue;
        const last = older[older.length - 1];
        if (last && last.role === 'assistant') last.content = clip(last.content + '\n' + line, 2400);
        else older.push({ role: 'assistant', content: line });
      }
    }
    const recent = older.slice(-16);
    while (recent.length && recent[0].role !== 'user') recent.shift();
    const out = recent.concat(convo.slice(start).map((m) => ({ ...m })));
    // Только последний снимок экрана: картинки тяжёлые.
    let images = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i].images) continue;
      if (images >= 1) delete out[i].images; else images += out[i].images.length;
    }
    const budget = Math.max(12000, Math.round(CTX * 2.6) - 22000);
    let total = out.reduce((n, m) => n + sizeOf(m), 0);
    let task = out.length - (convo.length - start); // где в out начинается текущая просьба
    // 1) прошлые просьбы, начиная с самых старых
    while (total > budget && task > 0) {
      total -= sizeOf(out.shift());
      task--;
      while (task > 0 && out[0].role !== 'user') { total -= sizeOf(out.shift()); task--; }
    }
    // 2) старые результаты шагов и устаревшие состояния текущей просьбы
    for (let i = task + 1; total > budget && i < out.length - 6; i++) {
      const m = out[i];
      if ((m.role === 'tool' || AUTO_MSG.test(String(m.content || ''))) && String(m.content || '').length > 400) {
        total -= sizeOf(m);
        m.content = clip(String(m.content), 300);
        delete m.images;
        total += sizeOf(m);
      }
    }
    // 3) самые ранние шаги текущей просьбы (целыми группами: ответ модели и результаты его шагов)
    let dropped = 0;
    while (total > budget && out.length - (task + 1) > 8) {
      let end = task + 2;
      while (end < out.length - 8 && out[end].role !== 'assistant') end++;
      const removed = out.splice(task + 1, end - (task + 1));
      if (!removed.length) break;
      dropped += removed.length;
      total -= removed.reduce((n, m) => n + sizeOf(m), 0);
    }
    if (dropped) {
      out.splice(task + 1, 0, { role: 'user', content: `[Ранние шаги этой просьбы (${dropped} сообщ.) убраны, чтобы уместиться в память модели. Что уже сделано — смотри по последнему состоянию.]` });
      if (out[task + 2] && out[task + 2].role === 'tool') out.splice(task + 2, 0, { role: 'assistant', content: '[продолжаю]' });
    }
    return out;
  }

  // Запрос к серверу помощника. Если сервер не принимает запрос со снимком экрана (nginx по
  // умолчанию берёт не больше 1 МБ и при большем просто обрывает соединение — браузер пишет
  // «Failed to fetch»), запрос повторяется без снимка, и дальше снимки не отправляются.
  const BODY_LIMIT = 900 * 1024;
  let imagesBlocked = false;
  const withoutImages = (payload) => ({ ...payload, messages: payload.messages.map((m) => { const { images, ...rest } = m; void images; return rest; }) });
  const hasImages = (payload) => payload.messages.some((m) => m.images && m.images.length);
  function tellImagesBlocked() {
    if (imagesBlocked) return;
    imagesBlocked = true;
    msg('note', 'Сервер не принял запрос со снимком экрана, поэтому помощник отвечает без него. ' +
      'Чтобы он видел экран, добавьте в nginx для api/assistant.php строку <code>client_max_body_size 20m;</code> (готовый блок — в nginx.conf.example).');
  }
  async function explainNoAnswer(seconds) {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const when = seconds >= 1 ? ` через ${Math.round(seconds)} с` : ' сразу';
        const why = seconds >= 45
          ? 'Похоже, сервер не дождался модели: для api/assistant.php нужна строка fastcgi_read_timeout 200s; (и такой же таймаут у прокси перед сервером, если он есть).'
          : 'Обычно так бывает, когда запрос больше, чем разрешает сервер (client_max_body_size 20m; для api/assistant.php), или его блокирует защита сервера.';
        return `Сервер оборвал соединение${when} и ничего не ответил, хотя сам помощник доступен. ${why} Готовый блок — в nginx.conf.example.`;
      }
      return `Сервер помощника ответил «${r.status}». Проверьте, что PHP обрабатывает файлы в папке api/.`;
    } catch {
      return 'Нет связи с сервером помощника: страница не может достучаться до api/assistant.php. Проверьте подключение и обновите страницу.';
    }
  }
  async function postApi(payload) {
    const post = (p) => fetch(CFG.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    if (imagesBlocked && hasImages(payload)) payload = withoutImages(payload);
    if (hasImages(payload) && JSON.stringify(payload).length > BODY_LIMIT) payload = withoutImages(payload);
    let r;
    const t0 = performance.now();
    const took = () => (performance.now() - t0) / 1000;
    try {
      r = await post(payload);
    } catch (e) {
      console.warn('AI-AutoCAD: запрос к помощнику оборвался', e);
      if (!hasImages(payload)) throw new Error(await explainNoAnswer(took()));
      try { r = await post(withoutImages(payload)); } catch { throw new Error(await explainNoAnswer(took())); }
      tellImagesBlocked();
      return r;
    }
    if (r.status === 413 && hasImages(payload)) {
      r = await post(withoutImages(payload));
      tellImagesBlocked();
    }
    return r;
  }
  async function readAnswer(r) {
    let j;
    try { j = await r.json(); } catch {
      if (r.status === 413) throw new Error('Сервер не принял такой большой запрос (413). Нужна строка client_max_body_size 20m; в nginx — см. nginx.conf.example.');
      if (r.status === 502 || r.status === 504) throw new Error(`Сервер не дождался ответа модели (${r.status}). Нужна строка fastcgi_read_timeout 200s; в nginx — см. nginx.conf.example.`);
      throw new Error(`Сервер помощника ответил не JSON (HTTP ${r.status}). Проверьте, что PHP работает в папке api/.`);
    }
    return j;
  }
  // Шлюз модели не передаёт инструменты штатно (вызовы приходят текстом) — запоминаем это.
  let textTools = store.get('textTools', false);
  async function ask() {
    const r = await postApi({ mode, messages: outgoing(), textTools });
    const j = await readAnswer(r);
    if (j && j.ok && j.textTools && !textTools) { textTools = true; store.set('textTools', true); }
    if (!j.ok) {
      const e = new Error(j.error || 'Ошибка помощника');
      e.noVision = !!j.noVision;
      throw e;
    }
    return j;
  }

  async function send(fromBar) {
    if (busy) { stopRequested = true; return; }
    const field = typeof fromBar === 'string' ? null : input;
    const text = (typeof fromBar === 'string' ? fromBar : input.value).trim();
    if (!text) return;
    if (field) { field.value = ''; autosize(); }
    setBusy(true);
    stopRequested = false;
    allowAllThisTurn = false;
    autoAllowNoted = false;
    seen = new Map();
    msg('user', esc(text));
    try {
      let state = null;
      let image = null;
      if (PC.ready()) {
        state = await snapshot().catch((e) => ({ error: e.message }));
        if (attachScreen) image = await screenshot();
      }
      turnStart = convo.length;
      convo.push({
        role: 'user',
        content: MODE_TAG[mode] + '\n' + text + '\n\n[Состояние редактора — автоматически]\n' + clip(JSON.stringify(state ?? { note: 'Редактор ещё загружается' }), 4000),
        ...(image ? { images: [image] } : {}),
      });
      await runSteps();
    } catch (e) {
      turnFailed(e);
    } finally {
      turnDone();
    }
  }
  // Продолжить ту же просьбу после остановки по числу шагов (без нового сообщения).
  async function continueTurn() {
    if (busy) return;
    setBusy(true);
    stopRequested = false;
    try { await runSteps(); } catch (e) { turnFailed(e); } finally { turnDone(); }
  }
  function turnFailed(e) {
    typing(false);
    if (e.noVision) setEye(false);
    msg('err', esc(e.message || String(e)));
  }
  function turnDone() {
    typing(false);
    setBusy(false);
    root.classList.remove('acting');
    updateBarAnswer();
  }
  // Повторы считаются за всю просьбу, в том числе после «Продолжить».
  let seen = new Map();
  async function runSteps() {
    const limit = agentSteps();
    for (let step = 0; ; step++) {
      if (stopRequested) { msg('bot', 'Остановлено.'); break; }
      if (step >= limit) {
        const d = msg('note', `Сделал ${limit} шагов подряд и остановился (так задано: «Настройки» внизу панели). `);
        const b = document.createElement('button');
        b.className = 'st-mini';
        b.textContent = 'Продолжить';
        b.onclick = () => { b.disabled = true; continueTurn(); };
        d.appendChild(b);
        break;
      }
      typing(true);
      const j = await ask();
      typing(false);
        const m = j.message || {};
        let calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        let content = (m.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<?function=[\w.-]+>[\s\S]*?(<\/function>|$)/g, '').replace(/<\/?tool_call>/g, '').trim();
        if (!calls.length) {
          calls = inlineCalls(content);
          if (calls.length) content = content.replace(/\{[\s\S]*\}/, '').trim();
        }
        // «Сделай», а модель всё равно ответила как в «Совете» — одна попытка её поправить.
        if (mode === 'act' && !calls.length && step === 0 && /режим\S*\s*«?Совет/i.test(content)) {
          convo.push({ role: 'assistant', content: m.content || '' });
          convo.push({ role: 'user', content: MODE_NOTE.act + ' Выполни просьбу сейчас.' });
          continue;
        }
        convo.push({ role: 'assistant', content: m.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (content) msg('bot', format(content));
        if (!calls.length) break;
        let pendingImage = null;
        let acted = false;
        for (const c of calls) {
          if (stopRequested) break;
          const fname = c.function && c.function.name;
          let a = (c.function && c.function.arguments) || {};
          if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch { a = {}; } }
          const sig = fname + ' ' + JSON.stringify(a || {});
          const times = (seen.get(sig) || 0) + 1;
          seen.set(sig, times);
          let result;
          try { result = await runTool(fname, a || {}); } catch (e) { result = { ok: false, error: e.message || String(e) }; }
          if (result && result.__image) { pendingImage = result.__image; delete result.__image; }
          const reading = READ_TOOLS.has(fname);
          if (!reading) acted = true;
          // Одно и то же действие по кругу — подсказываем модели остановиться и проверить результат.
          if (times >= (reading ? 4 : 3)) {
            const warning = `Ты уже ${times} раз(а) вызывал ${fname} с теми же параметрами. Не повторяй. `
              + (reading ? 'Всё нужное уже получено — действуй или заверши ответ.' : 'Проверь результат (get_state или look_at_screen) и переходи к следующей части задачи; если задача выполнена — заверши её коротким итогом.');
            result = (result && typeof result === 'object' && !Array.isArray(result)) ? { ...result, warning } : { result, warning };
          }
          convo.push({ role: 'tool', tool_name: fname, content: clip(JSON.stringify(result ?? { ok: true }), 6000) });
        }
        // После действий — свежее состояние документа (и снимок, если помощнику можно смотреть
        // на экран): модель видит, что уже сделано, и не рисует одно и то же заново.
        if (acted && !stopRequested && PC.ready()) {
          const st = await snapshot().catch(() => null);
          if (!pendingImage && attachScreen && store.get('agentLook', true)) pendingImage = await screenshot().catch(() => null);
          convo.push({
            role: 'user',
            content: '[Состояние после этих шагов — автоматически]\n' + clip(JSON.stringify(st ?? {}), 3500) + (pendingImage ? '\n(снимок экрана приложен)' : ''),
            ...(pendingImage ? { images: [pendingImage] } : {}),
          });
        } else if (pendingImage) {
          convo.push({ role: 'user', content: '[Снимок экрана после действий — прислан автоматически]', images: [pendingImage] });
        }
    }
  }

  // ------------------------------------------------------------------ быстрая строка
  // Ctrl+Shift+Пробел: поле внизу над холстом. Ответ всплывает над ним; вся история — в панели.
  const bar = $('bar');
  const barInput = $('barInput');
  const barAnswer = $('barAnswer');
  function setBar(open) {
    root.classList.toggle('bar-open', open);
    if (open) { setTimeout(() => barInput.focus(), 30); updateBarAnswer(); }
  }
  function updateBarAnswer() {
    if (!root.classList.contains('bar-open')) return;
    if (busy) { barAnswer.innerHTML = '<div class="st-typing"><i></i><i></i><i></i></div>'; barAnswer.hidden = false; return; }
    const last = [...log.querySelectorAll('.st-msg.bot, .st-msg.err')].pop();
    if (!last || !barSent) { barAnswer.hidden = true; return; }
    barAnswer.hidden = false;
    barAnswer.innerHTML = `<div class="st-bar-text ${last.classList.contains('err') ? 'err' : ''}">${last.innerHTML}</div><button class="st-link" data-a="panel">Открыть в панели</button>`;
    barAnswer.querySelector('[data-a="panel"]').onclick = () => { setBar(false); setOpen(true); };
  }
  let barSent = false;
  async function sendFromBar() {
    const text = barInput.value.trim();
    if (!text || busy) return;
    barInput.value = '';
    barSent = true;
    const done = send(text);
    updateBarAnswer();
    await done;
    updateBarAnswer();
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setBar(!root.classList.contains('bar-open'));
    }
  }, true);

  // ------------------------------------------------------------------ сообщения и перетаскивание
  function setBadge(on) { root.classList.toggle('has-hints', on); }
  function toast(text, error) {
    let t = root.querySelector('.st-toast');
    if (!t) { t = document.createElement('div'); t.className = 'st-toast'; root.appendChild(t); }
    t.textContent = text;
    t.classList.toggle('err', !!error);
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // Файлы, брошенные на чертёж, редактор принимает сам. Брошенные на панель помощника или край
  // окна браузер открыл бы вместо редактора — передаём их редактору.
  const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dropHideTimer = 0;
  function showDrop(on) {
    root.classList.toggle('dropping', on);
    clearTimeout(dropHideTimer);
    if (on) dropHideTimer = setTimeout(() => root.classList.remove('dropping'), 400);
  }
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById('cadcraft_canvas');
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    showDrop(true);
  });
  window.addEventListener('drop', async (e) => {
    showDrop(false);
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById('cadcraft_canvas');
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    const f = [...e.dataTransfer.files][0];
    if (!f || !PC.ready()) return;
    try { toast('Открываю ' + f.name); await VC().open(f.name, new Uint8Array(await f.arrayBuffer())); Files.forget(); }
    catch (err) { toast('Не удалось открыть ' + f.name + ': ' + (err.message || err), true); }
  });

  // ------------------------------------------------------------------ файлы на сервере
  // Новый пустой чертёж (миллиметры) — в новой вкладке редактора.
  async function newDocument() {
    await PC.exec('new', { metric: true });
  }
  const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ');
  const fmtDate = (t) => {
    if (!t) return '';
    const d = new Date(t * 1000), now = new Date();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'сегодня, ' + time;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + time;
  };
  const DOC_EXT = /\.(dwg|dxf|dwt)$/i;
  // Формат по умолчанию: DWG (как у AutoCAD); имя с .dxf/.dwt сохраняется как есть.
  const DEFAULT_EXT = '.dwg';

  // Окно с одним полем: имя файла.
  function askName(title, value, note) {
    return new Promise((resolve) => {
      const box = $('ask');
      $('askTitle').textContent = title;
      $('askNote').textContent = note || '';
      const field = $('askInput');
      field.value = value || '';
      box.hidden = false;
      setTimeout(() => { field.focus(); const dot = field.value.lastIndexOf('.'); field.setSelectionRange(0, dot > 0 ? dot : field.value.length); }, 30);
      const done = (v) => { box.hidden = true; form.onsubmit = null; $('askCancel').onclick = null; box.onkeydown = null; resolve(v); };
      const form = box.querySelector('form');
      form.onsubmit = (e) => { e.preventDefault(); done(field.value.trim() || null); };
      $('askCancel').onclick = () => done(null);
      box.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    });
  }

  // Копия в браузере, если сохранить на сервер не вышло (нет связи, сервер не принял файл).
  const Recovery = (() => {
    const open = () => new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('нет IndexedDB')); return; }
      const r = indexedDB.open('aiautocad', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('recovery');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('recovery', mode);
        const req = fn(tx.objectStore('recovery'));
        tx.oncomplete = () => { db.close(); resolve(req && req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    };
    return {
      put: (v) => run('readwrite', (s) => s.put(v, 'last')).catch(() => {}),
      get: () => run('readonly', (s) => s.get('last')).catch(() => null),
      clear: () => run('readwrite', (s) => s.delete('last')).catch(() => {}),
    };
  })();

  // Скачать файл, который сохранить на сервер не вышло (или который сервер не принимает).
  function download(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const b64bytes = (b64) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

  const Files = (() => {
    let list = [];
    let server = null;        // имя открытого чертежа на сервере, если он оттуда
    const known = new Set();  // имена файлов на сервере, открытые или сохранённые здесь
    let dirty = false;
    let saveAsNext = false;   // «Сохранить как» из панели
    let quietNext = false;    // автосохранение
    let silentNext = false;   // своё переименование чертежа после сохранения под другим именем
    let saving = false;
    const api = (q) => CFG.files + (q ? '?' + q : '');
    async function json(r) {
      let j = null;
      try { j = await r.json(); } catch { /* ниже */ }
      if (!j) throw new Error(r.status === 413 ? 'Файл слишком большой для сервера: увеличьте client_max_body_size в nginx и post_max_size в PHP.' : `Сервер ответил ${r.status}: проверьте, что PHP обрабатывает api/files.php.`);
      if (!j.ok) { const e = new Error(j.error || 'Ошибка сервера'); e.exists = !!j.exists; e.login = !!j.login; throw e; }
      return j;
    }
    async function refresh() {
      const j = await json(await fetch(api(''), { credentials: 'same-origin', cache: 'no-store' }));
      list = Array.isArray(j.files) ? j.files : [];
      $('filesWho').textContent = j.user && j.user !== 'local' ? 'на сервере · пользователь ' + j.user : 'на сервере';
      return list;
    }
    const stem = (n) => String(n || '').replace(DOC_EXT, '');
    const withExt = (n) => (DOC_EXT.test(n) ? n : stem(n) + DEFAULT_EXT);
    function render() {
      const q = norm($('filesSearch').value).trim();
      const rows = list.filter((f) => !q || norm(f.name).includes(q));
      const box = $('filesList');
      if (!list.length) { box.innerHTML = '<p class="st-files-empty">Здесь будут ваши чертежи. Сохраните открытый чертёж кнопкой «Сохранить» или Ctrl+S. Открыть можно файлы .dwg, .dxf и .dwt.</p>'; return; }
      if (!rows.length) { box.innerHTML = '<p class="st-files-empty">Ничего не найдено.</p>'; return; }
      box.innerHTML = rows.map((f, i) => `<div class="st-file" data-i="${i}" tabindex="0">
          <span class="st-file-icon">${ICON.file}</span>
          <span class="st-file-name">${esc(f.name)}</span>
          <span class="st-file-meta">${esc(fmtDate(f.modified))} · ${esc(fmtSize(f.size))}</span>
          <span class="st-file-acts"><button class="st-link" data-a="rename">Переименовать</button><button class="st-link danger" data-a="delete">Удалить</button></span>
        </div>`).join('');
      box.querySelectorAll('.st-file').forEach((row) => {
        const f = rows[+row.dataset.i];
        row.onclick = (e) => { if (!e.target.closest('button')) load(f.name); };
        row.onkeydown = (e) => { if (e.key === 'Enter') load(f.name); };
        row.querySelector('[data-a="rename"]').onclick = () => rename(f.name);
        row.querySelector('[data-a="delete"]').onclick = () => remove(f.name);
      });
    }
    function updateFoot() {
      $('filesCurrent').textContent = server ? `Открыт «${server}»` + (dirty ? ' · есть изменения' : '') : (dirty ? 'Чертёж ещё не сохранён на сервере' : '');
    }
    async function show(on = true) {
      $('files').hidden = !on;
      if (!on) return;
      $('filesList').innerHTML = '<p class="st-files-empty">Загружаю список…</p>';
      updateFoot();
      try { await refresh(); render(); } catch (e) { $('filesList').innerHTML = `<p class="st-files-empty err">${esc(e.message)}</p>`; }
      setTimeout(() => $('filesSearch').focus(), 30);
    }
    async function documents() {
      try { const ui = await PC.call('ui.inspect'); return (ui && ui.session && Array.isArray(ui.session.documents)) ? ui.session.documents : []; } catch { return []; }
    }
    async function load(name) {
      try {
        // Уже открыт в редакторе — просто перейти на его вкладку.
        const docs = await documents();
        const i = docs.findIndex((d) => d.title === name || (d.path && d.path === name));
        if (i >= 0 && known.has(name)) { await PC.exec('switch', { index: i }).catch(() => PC.call('ui.menu.invoke', { command: 'ui.tab.' + i })); server = name; show(false); return; }
        toast('Открываю «' + name + '»…');
        const r = await fetch(api('action=load&name=' + encodeURIComponent(name)), { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) await json(r);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const before = docs.length;
        await VC().open(name, bytes);
        show(false);
        // Чертёж открывается на следующих кадрах (большой DWG — несколько секунд).
        for (let k = 0; k < 600 && (await documents()).length <= before; k++) await sleep(100);
        if ((await documents()).length <= before) throw new Error('редактор не открыл файл (подробности — в командной строке)');
        server = name;
        known.add(name);
      } catch (e) { toast('Не удалось открыть: ' + e.message, true); }
    }
    async function upload(name, bytes, overwrite) {
      const r = await fetch(api('action=save&name=' + encodeURIComponent(name) + (overwrite ? '&overwrite=1' : '')), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      });
      return json(r);
    }
    // Сохранение из редактора (Ctrl+S, Файл › Сохранить, «Сохранить как»): чертёж приходит сюда.
    async function onSave(detail) {
      const bytes = detail.bytes;
      const given = String(detail.name || '');
      if (silentNext) { silentNext = false; known.add(given); server = given; return; }
      const quiet = quietNext;
      const asked = saveAsNext || !!detail.saveAs;
      quietNext = false;
      saveAsNext = false;
      let name = !asked && given && known.has(given) ? given : null;
      let overwrite = !!name;
      try {
        saving = true;
        if (!name) {
          if (quiet) return;
          const suggest = withExt((given || 'Чертёж').replace(/^Drawing(\d*)/, (m, n) => 'Чертёж' + (n && n !== '1' ? ' ' + n : '')));
          name = await askName(asked ? 'Сохранить как' : 'Сохранить на сервере', suggest, 'Чертёж появится в «Моих чертежах». Формат — по расширению: .dwg, .dxf или .dwt.');
          if (!name) { dirty = true; download(given || 'Чертёж.dwg', bytes); toast('На сервер не сохранено — файл скачан в браузере.'); return; }
          name = withExt(name.trim());
          if (!list.length) await refresh().catch(() => {});
          if (list.some((f) => f.name === name) && name !== server && !window.confirm(`Чертёж «${name}» уже есть. Заменить его?`)) { dirty = true; return; }
          overwrite = true;
        }
        let data = bytes;
        // Другое расширение, чем сохранил редактор (выбрали .dxf вместо .dwg): переписываем в нужный формат.
        if (name.split('.').pop().toLowerCase() !== given.split('.').pop().toLowerCase()) {
          silentNext = true;
          try { await PC.exec('saveas', { path: name }); } catch (e) { silentNext = false; throw e; }
          const fmt = name.split('.').pop().toLowerCase() === 'dxf' ? 'dxf' : 'dwg';
          const out = await PC.exec('export', { format: fmt });
          if (out && out.data) data = b64bytes(out.data);
        } else if (name !== given) {
          // Тот же формат, другое имя: редактор запоминает новое имя (без второй загрузки на сервер).
          silentNext = true;
          await PC.exec('saveas', { path: name }).catch(() => { silentNext = false; });
        }
        const r = await upload(name, data, overwrite);
        server = r.name;
        known.add(r.name);
        Recovery.clear();
        if (!quiet) toast('Сохранено: «' + r.name + '»');
        if (!$('files').hidden) { await refresh().catch(() => {}); render(); updateFoot(); }
      } catch (e) {
        Recovery.put({ name: name || given, data: bytes, time: Date.now() });
        if (e.login) toast('Войдите в систему, чтобы сохранять чертежи на сервере. Копия осталась в браузере.', true);
        else if (!quiet) { download(name || given || 'Чертёж.dwg', bytes); toast('Не удалось сохранить на сервер: ' + e.message + '. Файл скачан в браузере.', true); }
        else toast('Автосохранение не удалось: ' + e.message + '. Копия осталась в браузере.', true);
      } finally { saving = false; }
    }
    // «Сохранить»: у чертежа уже есть имя — QSAVE туда же; нет — как «Сохранить как» (редактор
    // предложит имя, панель спросит своё).
    async function save(saveAs) {
      if (!PC.ready()) return;
      saveAsNext = !!saveAs;
      try {
        let path = null;
        try { path = (await PC.call('drawing.inspect', { entities: false })).path; } catch { throw new Error('сначала откройте или создайте чертёж'); }
        if (saveAs || !path) await PC.exec('ui.saveas'); else await PC.exec('qsave');
      } catch (e) { saveAsNext = false; toast('Не удалось сохранить: ' + e.message, true); }
    }
    async function rename(name) {
      const to0 = await askName('Переименовать', name);
      if (!to0 || to0 === name) return;
      const to = DOC_EXT.test(to0) ? to0 : to0 + (name.match(DOC_EXT) || [DEFAULT_EXT])[0];
      try {
        await json(await fetch(api('action=rename'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, to }) }));
        if (known.has(name)) { known.delete(name); known.add(to); }
        if (server === name) {
          server = to;
          silentNext = true;
          await PC.exec('saveas', { path: to }).catch(() => { silentNext = false; });
        }
        await refresh(); render(); updateFoot();
      } catch (e) { toast('Не удалось переименовать: ' + e.message, true); }
    }
    async function remove(name) {
      if (!window.confirm(`Удалить «${name}»? Файл уйдёт в корзину на сервере.`)) return;
      try {
        await json(await fetch(api('action=delete'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }));
        if (server === name) server = null;
        known.delete(name);
        await refresh(); render();
      } catch (e) { toast('Не удалось удалить: ' + e.message, true); }
    }
    function pickLocal() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.dwg,.dxf,.dwt';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try { await VC().open(f.name, new Uint8Array(await f.arrayBuffer())); server = null; show(false); toast('Открыт «' + f.name + '». Сохраните его (Ctrl+S), чтобы он появился в «Моих чертежах».'); }
        catch (e) { toast('Не удалось открыть ' + f.name + ': ' + e.message, true); }
      };
      input.click();
    }
    async function offerRecovery() {
      const r = await Recovery.get();
      if (!r || !r.data) return;
      const when = new Date(r.time).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const d = msg('note', `Чертёж «${esc(r.name)}» от ${esc(when)} не удалось сохранить на сервер — его копия осталась в браузере. ` +
        '<span class="st-row"><button class="st-mini" data-a="open">Открыть копию</button><button class="st-mini" data-a="get">Скачать</button><button class="st-mini danger" data-a="drop">Удалить копию</button></span>');
      d.querySelector('[data-a="open"]').onclick = async () => {
        try { await VC().open(r.name, r.data); server = null; d.remove(); toast('Копия открыта. Сохраните её (Ctrl+S).'); }
        catch (e) { toast('Не удалось открыть копию: ' + e.message, true); }
      };
      d.querySelector('[data-a="get"]').onclick = () => download(r.name || 'Чертёж.dwg', r.data);
      d.querySelector('[data-a="drop"]').onclick = () => { Recovery.clear(); d.remove(); };
      setOpen(true);
    }
    // Раз в autosaveSeconds: чертёж, который уже лежит на сервере, сохраняется туда сам.
    async function tick() {
      for (;;) {
        await sleep(Math.max(15, CFG.autosaveSeconds || 60) * 1000);
        if (!CFG.autosaveSeconds || document.hidden || !PC.ready() || saving || !server || !dirty) continue;
        // Не мешаем команде, которая идёт в командной строке.
        try { const cl = await PC.call('cmdline.state'); if (cl && cl.running) continue; } catch { continue; }
        quietNext = true;
        await PC.exec('qsave').catch(() => { quietNext = false; });
      }
    }
    function start() {
      VC().takesSaves = true;
      window.addEventListener('aiautocad:save', (e) => onSave(e.detail || {}));
      window.addEventListener('aiautocad:dirty', (e) => { dirty = !!(e.detail && e.detail.dirty); if (!$('files').hidden) updateFoot(); });
      $('filesBtn').onclick = () => show(true);
      $('filesClose').onclick = () => show(false);
      $('files').addEventListener('pointerdown', (e) => { if (e.target === $('files')) show(false); });
      $('files').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('ask').hidden) { e.preventDefault(); show(false); } });
      $('filesSearch').addEventListener('input', render);
      $('filesNew').onclick = async () => { try { await newDocument(); server = null; show(false); } catch (e) { toast(e.message, true); } };
      $('filesUpload').onclick = pickLocal;
      $('filesSave').onclick = () => save(false);
      $('filesSaveAs').onclick = () => save(true);
      // Браузер не должен предлагать «Сохранить страницу как…».
      window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) e.preventDefault(); }, true);
      offerRecovery();
      tick();
      if (CFG.filesOnStart) refresh().then((l) => { if (l.length) show(true); }).catch(() => {});
    }
    return { start, show, save, stem, current: () => server, forget: () => { server = null; }, isServer: (p) => !!p && known.has(p), download };
  })();

  // ------------------------------------------------------------------ шрифты
  // Метрически совместимые открытые шрифты (fonts/manifest.json: Liberation вместо Arial, Times New Roman
  // и Courier New; в них есть кириллица) и шрифты организации с сервера (api/files.php?action=fonts:
  // TrueType и чертёжные SHX): надписи на чертежах рисуются ими.
  const Fonts = (() => {
    let loaded = 0;
    async function add(name, url) {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = await VC().addFont(name, new Uint8Array(await r.arrayBuffer()));
      if (res && res.faces) loaded += res.faces;
    }
    async function start() {
      // Сначала шрифты организации (настоящие гарнитуры и SHX), потом открытые двойники.
      try {
        const j = await (await fetch(CFG.files + '?action=fonts', { credentials: 'same-origin', cache: 'no-store' })).json();
        for (const f of (j && j.ok && j.fonts) || []) {
          await add(f.name, CFG.files + '?action=font&name=' + encodeURIComponent(f.name)).catch((e) => console.warn('AI-AutoCAD: шрифт ' + f.name, e));
        }
      } catch { /* нет входа или сервера — только двойники */ }
      try {
        const m = await (await fetch(CFG.fonts, { cache: 'no-cache' })).json();
        for (const f of (m && m.fonts) || []) {
          await add(f.file, 'fonts/' + encodeURIComponent(f.file)).catch((e) => console.warn('AI-AutoCAD: шрифт ' + f.file, e));
        }
      } catch { /* сборка без шрифтов */ }
      // Открытые чертежи перерисовываются с новыми шрифтами.
      if (loaded) await PC.exec('regenall').catch(() => {});
      return loaded;
    }
    return { start, faces: () => loaded };
  })();

  // ------------------------------------------------------------------ быстрые задачи
  const needDoc = async () => {
    let n = 0;
    try { const ui = await PC.call('ui.inspect'); n = ui && ui.session && Array.isArray(ui.session.documents) ? ui.session.documents.length : 0; } catch { /* ниже */ }
    if (!n) throw new Error('Сначала откройте или создайте чертёж.');
  };
  // Чертёж в PDF на лист (весь чертёж, по размеру листа, с толщинами линий) — скачивается.
  async function pdf(paper) {
    await needDoc();
    const r = await PC.exec('exportpdf', { paper, fit: true, lineweights: true, plotArea: 'extents' });
    if (!r || !r.data) throw new Error('PDF не получился');
    let title = 'Чертёж';
    try { const d = await PC.call('drawing.inspect', { entities: false }); title = String(d.title || title).replace(/\.(dwg|dxf|dwt)$/i, ''); } catch { /* имя по умолчанию */ }
    Files.download(title + '.pdf', b64bytes(r.data));
  }
  const eskd = (fn, args) => async () => {
    await needDoc();
    if (!ESKD()) throw new Error('Модуль ЕСКД не загрузился');
    const r = await ESKD()[fn](PC, args || {});
    return r && r.message;
  };
  // Те, что делаются командами, — сразу; остальные — через помощника (! — сделать, ? — объяснить).
  const TASKS = [
    ['ЕСКД', [
      ['Рамка A4 со штампом', 'Рамка 20/5 мм, основная надпись форма 1 (185×55)', eskd('sheet', { format: 'A4' })],
      ['Рамка A3 со штампом', 'Горизонтальный лист, основная надпись форма 1', eskd('sheet', { format: 'A3', orientation: 'landscape' })],
      ['Рамка A2 со штампом', 'Горизонтальный лист', eskd('sheet', { format: 'A2', orientation: 'landscape' })],
      ['Рамка A1 со штампом', 'Горизонтальный лист', eskd('sheet', { format: 'A1', orientation: 'landscape' })],
      ['Слои и типы линий ГОСТ', 'Основная, тонкая, осевая, штриховая, размеры, текст', eskd('setup')],
      ['Размеры у выделенного', 'Отрезки, окружности, дуги, полилинии', eskd('dimensionSelected')],
      ['Заполнить штамп', 'Наименование, обозначение, разработчик…', '!Заполни основную надпись (штамп) чертежа. Наименование: '],
    ]],
    ['Проверка', [
      ['Проверить чертёж', 'Незамкнутые контуры, слои, типы линий, ЕСКД', '!Проверь чертёж (check_drawing): незамкнутые контуры, объекты на слое 0, типы и толщины линий по ГОСТ 2.303, текст и размеры. Перечисли найденное и предложи исправления.'],
      ['Удалить дубликаты', 'Наложенные друг на друга объекты', '!Найди и удали наложенные друг на друга (дублирующиеся) объекты (команда overkill). Скажи, сколько удалено.'],
      ['Технические требования', 'Оформить по ГОСТ 2.316 над штампом', '!Оформи технические требования над основной надписью (многострочный текст, пункты с номерами, шрифт 3,5 по ГОСТ 2.304). Требования: '],
      ['Что на чертеже', 'Кратко: объекты, слои, размеры', '?Кратко опиши чертёж: что на нём изображено, какие слои, сколько объектов и размеров, чего не хватает для оформления по ЕСКД.'],
    ]],
    ['Чертить', [
      ['Деталь по описанию', 'Помощник начертит по размерам', '!Начерти по размерам в миллиметрах (контур основной толстой линией, оси штрихпунктирной, проставь размеры): '],
      ['Новый чертёж', 'Миллиметры, слои ГОСТ', async () => { await newDocument(); Files.forget(); if (ESKD()) await ESKD().setup(PC, {}); return 'Новый чертёж в миллиметрах со слоями по ГОСТ'; }],
      ['Показать всё', 'Весь чертёж в окне', async () => { await needDoc(); await PC.exec('zoom.extents'); }],
    ]],
    ['Файл', [
      ['Сохранить на сервер', 'Ctrl+S', async () => { await Files.save(false); }],
      ['Сохранить как…', 'Под другим именем в «Моих чертежах»', async () => { await Files.save(true); }],
      ['Скачать PDF A4', 'Весь чертёж на лист A4', async () => { await pdf('A4'); }],
      ['Скачать PDF A3', 'Весь чертёж на лист A3', async () => { await pdf('A3'); }],
    ]],
  ];
  const Gallery = (() => {
    function show(on = true) {
      $('gallery').hidden = !on;
      if (on) renderTasks();
    }
    function renderTasks() {
      $('gTasks').innerHTML = TASKS.map(([group, items], gi) => `<section><h4>${esc(group)}</h4><div>${items.map(([n, d], i) => `<button class="st-task" data-g="${gi}" data-i="${i}"><b>${esc(n)}</b><small>${esc(d)}</small></button>`).join('')}</div></section>`).join('');
      $('gTasks').querySelectorAll('.st-task').forEach((b) => {
        const [, , run] = TASKS[+b.dataset.g][1][+b.dataset.i];
        b.onclick = async () => {
          if (typeof run === 'string') {
            show(false);
            setOpen(true);
            setMode(run.startsWith('?') ? 'advice' : 'act');
            const text = run.replace(/^[!?]/, '');
            input.value = text;
            if (text.endsWith(': ')) { autosize(); input.focus(); input.setSelectionRange(text.length, text.length); }
            else send();
            return;
          }
          b.disabled = true;
          try { const note = await run(); show(false); toast((note ? String(note) : 'Готово: ' + b.querySelector('b').textContent) + '. Ctrl+Z — отменить.'); }
          catch (e) { toast(e.message, true); }
          finally { b.disabled = false; }
        };
      });
    }
    function start() {
      $('galleryBtn').onclick = () => show(true);
      $('galleryClose').onclick = () => show(false);
      $('gallery').addEventListener('pointerdown', (e) => { if (e.target === $('gallery')) show(false); });
      $('gallery').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); show(false); } });
    }
    return { start, show };
  })();

  // ------------------------------------------------------------------ ИИ у выделения
  // Кнопка «ИИ» справа в панели инструментов и «ИИ у выделения…» в контекстном меню чертежа
  // присылают событие aiautocad:ai; Ctrl+Alt+Пробел открывает то же меню над чертежом. Модель видит
  // все надписи чертежа (большой — частями, см. api/context.php), а работает с выделенными
  // надписями (текст, многострочный текст, атрибуты) или — без выделения — с чертежом целиком.
  // Результат не попадает в чертёж сам: его можно заменить, поставить новой надписью или скопировать.
  const AI_MENU = [
    ['Надпись', [['fix_grammar', 'Исправить ошибки'], ['improve', 'Поправить надпись'], ['eskd_abbr', 'Сокращения по ГОСТ 2.316'], ['shorten', 'Сократить'], ['upper', 'Прописными буквами']]],
    ['Оформить', [['tech_req', 'Технические требования'], ['note', 'Примечание'], ['title_name', 'Наименование для штампа'], ['to_list', 'Пронумеровать пункты']]],
    ['Перевод', [['translate_ru', 'На русский'], ['translate_en', 'На английский'], ['translate_be', 'На белорусский'], ['translate_de', 'На немецкий'], ['translate_zh', 'На китайский']]],
    ['Чертёж', [['check_text', 'Проверить надписи'], ['summarize', 'Что на чертеже'], ['explain', 'Объяснить']]],
  ];
  // Эти операции переписывают надпись: главная кнопка результата — «Заменить».
  const AI_REWRITES = /^(improve|fix_grammar|eskd_abbr|shorten|upper|tech_req|note|title_name|to_list|translate_|custom)/;
  const AI_LABEL = Object.fromEntries(AI_MENU.flatMap((g) => g[1]));

  // Markdown модели → простой HTML: абзацы, подзаголовки, списки, таблицы, полужирный и курсив.
  function mdToHtml(md) {
    const inline = (s) => esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(«])\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)»]|$)/g, '$1<i>$2</i>')
      .replace(/`([^`\n]+)`/g, '$1');
    const out = [];
    let list = null;
    let rows = null;
    const close = () => {
      if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; }
      if (rows) {
        const [head, ...body] = rows;
        const cells = (r, t) => r.map((c) => `<${t}>${inline(c)}</${t}>`).join('');
        out.push(`<table border="1" style="border-collapse:collapse"><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>`);
        rows = null;
      }
    };
    for (const raw of String(md).replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (list) close();
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) continue; // строка-разделитель
        rows = rows || [];
        rows.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      } else if ((m = line.match(/^\s*[-*•–]\s+(.*)$/))) {
        if (rows || (list && list.tag !== 'ul')) close();
        list = list || { tag: 'ul', items: [] };
        list.items.push(m[1]);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (rows || (list && list.tag !== 'ol')) close();
        list = list || { tag: 'ol', items: [] };
        list.items.push(m[1]);
      } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        close();
        const level = Math.min(4, Math.max(2, m[1].length));
        out.push(`<h${level}>${inline(m[2].replace(/#+\s*$/, ''))}</h${level}>`);
      } else if (!line.trim()) {
        close();
      } else {
        close();
        out.push(`<p>${inline(line.trim())}</p>`);
      }
    }
    close();
    return out.join('');
  }
  const mdPlain = (md) => String(md).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').trim();
  const mdStructured = (md) => /^\s*([-*•–]\s|\d+[.)]\s|#{1,6}\s|\|)/m.test(md);
  // Строки результата без разметки Markdown: «- пункт» → «пункт», «# Заголовок» → «Заголовок».
  const mdLines = (md) => mdPlain(md).split('\n').map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').trim()).filter(Boolean);

  const ai = { pop: null, sel: null, op: null, custom: '', result: '', abort: null };

  function aiClose() {
    if (ai.abort) ai.abort.abort();
    ai.abort = null;
    ai.pop?.remove();
    ai.pop = null;
  }
  function aiPlace(x, y) {
    const pop = ai.pop;
    const w = pop.offsetWidth; const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = y + h + 8 <= window.innerHeight ? y : Math.max(8, Math.min(y - h - 12, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  const SCOPE_TEXT = { one: 'Надпись', many: 'Надписи', doc: 'Чертёж' };
  const TEXT_TYPES = new Set(['text', 'mText', 'attDef']);
  // Что выделено: одна надпись (one), несколько (many) или ничего из надписей (doc — весь чертёж).
  async function aiSelection() {
    const d = await PC.call('drawing.inspect', { entities: false });
    const sel = Array.isArray(d.selection) ? d.selection : [];
    let texts = [];
    if (sel.length) {
      const r = await PC.exec('entities', { selected: true, limit: 200 });
      texts = (r.entities || []).filter((e) => e.geometry && TEXT_TYPES.has(e.geometry.type)).map((e) => {
        const g = e.geometry;
        const mtext = g.type === 'mText';
        return { handle: e.handle, mtext, text: mtext ? plainMtext(g.contents) : String(g.value ?? (g.text && g.text.value) ?? ''), at: P(g.insert), height: Number(g.height) || 3.5, width: Number(g.width) || 0 };
      });
    }
    if (texts.length === 1) return { scope: 'one', texts, text: texts[0].text };
    if (texts.length > 1) return { scope: 'many', texts, text: texts.map((t) => t.text).join('\n') };
    return { scope: 'doc', texts: [], text: '' };
  }
  // Все надписи чертежа — контекст для модели (большой сервер отдаёт частями, см. api/context.php).
  async function documentText() {
    const parts = [];
    let size = 0;
    for (const type of ['text', 'mtext']) {
      const r = await PC.exec('entities', { type, limit: 1000 }).catch(() => null);
      for (const e of (r && r.entities) || []) {
        const g = e.geometry || {};
        const t = (g.type === 'mText' ? plainMtext(g.contents) : String(g.value || '')).trim();
        if (!t) continue;
        parts.push(t);
        size += t.length;
        if (size > 400000) break;
      }
    }
    return parts.join('\n');
  }
  async function aiOpen(x, y) {
    aiClose();
    if (!PC.ready()) return;
    let sel;
    try { sel = await aiSelection(); } catch { toast('Сначала откройте или создайте чертёж.', true); return; }
    sel.text = String(sel.text || '').slice(0, CFG.aiMaxChars || 60000);
    ai.sel = sel;
    const text = sel.text.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const what = SCOPE_TEXT[sel.scope] || 'Чертёж';
    const pop = document.createElement('div');
    pop.className = 'st-ai-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'ИИ у выделения');
    const many = sel.scope === 'many' ? ` · ${sel.texts.length} ${plural(sel.texts.length, 'надпись', 'надписи', 'надписей')}` : '';
    pop.innerHTML = `
      <div class="st-ai-head">
        <span class="st-ai-mark">${ICON.spark}</span>
        <input class="st-ai-input" type="text" placeholder="${sel.scope === 'doc' ? 'Что сделать с чертежом?' : 'Что сделать с надписью?'}" aria-label="Свой запрос или поиск по меню" autocomplete="off">
        <button class="st-ai-x" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
      </div>
      <div class="st-ai-scope">${text ? `${esc(what)}: <b>${esc(text.length > 70 ? text.slice(0, 70) + '…' : text)}</b> · ${words} ${plural(words, 'слово', 'слова', 'слов')}${esc(many)}` : 'Надписи не выбраны — работаю с чертежом целиком. Чтобы поправить надпись, выделите её (текст или многострочный текст).'}</div>
      <div class="st-ai-body"></div>
      <div class="st-ai-foot">Enter — свой запрос · Esc — закрыть · Ctrl+Alt+Пробел — открыть над чертежом</div>`;
    root.appendChild(pop);
    ai.pop = pop;
    const field = pop.querySelector('.st-ai-input');
    pop.querySelector('.st-ai-x').onclick = aiClose;
    field.addEventListener('input', () => aiMenu(field.value));
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); aiClose(); }
      if (e.key === 'Enter' && field.value.trim()) { e.preventDefault(); aiRun('custom', field.value.trim()); }
      if (e.key === 'ArrowDown') { e.preventDefault(); pop.querySelector('.st-ai-item')?.focus(); }
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); aiClose(); }
      const items = [...pop.querySelectorAll('.st-ai-item')];
      const i = items.indexOf(document.activeElement);
      if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault(); e.stopPropagation();
        (items[i + (e.key === 'ArrowDown' ? 1 : -1)] || (e.key === 'ArrowUp' ? field : items[i])).focus();
      }
    });
    aiMenu('');
    ai.anchor = [x, y];
    aiPlace(x, y);
    field.focus();
  }
  function plural(n, one, few, many) {
    const d = n % 10; const h = n % 100;
    return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  }
  function aiMenu(query) {
    const body = ai.pop?.querySelector('.st-ai-body');
    if (!body) return;
    const q = query.trim().toLowerCase();
    const noText = !(ai.sel && ai.sel.text && ai.sel.text.trim());
    const keepWithout = /^(tech_req|note|title_name|check_text|summarize|explain)$/;
    const groups = AI_MENU
      .map(([g, items]) => [g, items.filter(([id, label]) => (!q || label.toLowerCase().includes(q) || g.toLowerCase().includes(q)) && !(noText && AI_REWRITES.test(id) && !keepWithout.test(id)))])
      .filter((g) => g[1].length);
    body.innerHTML = groups.length
      ? groups.map(([g, items]) => `<div class="st-ai-group"><div class="st-ai-gt">${esc(g)}</div><div class="st-ai-items">${items.map(([id, label]) => `<button class="st-ai-item" data-op="${id}">${esc(label)}</button>`).join('')}</div></div>`).join('')
      : `<button class="st-ai-item st-ai-custom" data-op="custom">${ICON.send}<span>Выполнить: «${esc(query.trim())}»</span></button>`;
    body.querySelectorAll('.st-ai-item').forEach((b) => {
      b.onclick = () => (b.dataset.op === 'custom' ? aiRun('custom', query.trim()) : aiRun(b.dataset.op, ''));
    });
    if (ai.anchor) aiPlace(...ai.anchor);
  }
  // Что можно сделать с результатом: [действие, подпись, главное?].
  function aiActions(op) {
    const sel = ai.sel || {};
    const acts = [];
    if (AI_REWRITES.test(op) && sel.scope === 'one') acts.push(['replace', 'Заменить надпись', true]);
    if (AI_REWRITES.test(op) && sel.scope === 'many' && op !== 'tech_req' && op !== 'note') acts.push(['replaceEach', 'Заменить по строкам', false]);
    acts.push(['newText', sel.scope === 'doc' ? 'Новой надписью в центре вида' : 'Новой надписью ниже', !acts.length]);
    return acts;
  }
  async function aiRun(op, custom) {
    if (!ai.pop) return;
    ai.op = op; ai.custom = custom;
    const body = ai.pop.querySelector('.st-ai-body');
    const title = op === 'custom' ? custom : (AI_LABEL[op] || op);
    body.innerHTML = `<div class="st-ai-res"><div class="st-ai-rt">${esc(title)}</div><div class="st-ai-wait"><div class="st-typing"><i></i><i></i><i></i></div><span>Думаю…</span><button class="st-mini" data-a="stop">Отменить</button></div></div>`;
    ai.pop.querySelector('.st-ai-foot').hidden = true;
    body.querySelector('[data-a="stop"]').onclick = () => { ai.abort?.abort(); aiMenu(ai.pop.querySelector('.st-ai-input').value); ai.pop.querySelector('.st-ai-foot').hidden = false; };
    aiPlace(...ai.anchor);
    let doc = '';
    try { doc = await documentText(); } catch { /* без контекста */ }
    const sel = ai.sel || {};
    let extra = '';
    if (sel.scope === 'many' && AI_REWRITES.test(op)) extra = `Выделено ${sel.texts.length} отдельных надписей, по одной на строку. Если задача — поправить или перевести, верни столько же строк в том же порядке, без нумерации.`;
    ai.abort = new AbortController();
    const payload = { mode: 'text', op: op === 'custom' ? '' : op, custom: op === 'custom' ? custom : '', extra, selection: sel.text || '', document: doc };
    let j;
    try {
      const r = await fetch(CFG.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ai.abort.signal });
      j = await readAnswer(r);
    } catch (e) {
      if (e.name === 'AbortError') return;
      j = { ok: false, error: e.message };
    }
    ai.abort = null;
    if (!ai.pop) return;
    if (!j || !j.ok) {
      body.innerHTML = `<div class="st-ai-res"><div class="st-ai-rt">${esc(title)}</div><p class="st-ai-err">${esc((j && j.error) || 'Модель не ответила.')}</p><div class="st-ai-acts"><button class="st-mini" data-a="back">Назад</button><button class="st-mini" data-a="again">Ещё раз</button></div></div>`;
    } else {
      ai.result = String(j.message?.content || '').trim();
      const ctxNote = j.context === 'windowed' ? 'надписей много: учтены начало и текст вокруг' : 'учтены все надписи чертежа';
      const acts = aiActions(op);
      body.innerHTML = `<div class="st-ai-res">
        <div class="st-ai-rt">${esc(title)}<small>${esc(ctxNote)}</small></div>
        <div class="st-ai-out">${mdToHtml(ai.result) || '<p>(пустой ответ)</p>'}</div>
        <div class="st-ai-acts">
          ${acts.map(([a, label, main]) => `<button class="st-mini ${main ? 'primary' : ''}" data-a="${a}">${esc(label)}</button>`).join('')}
          <button class="st-mini" data-a="copy">Копировать</button>
          <button class="st-mini" data-a="again" title="Другой вариант">Ещё вариант</button>
          <button class="st-mini" data-a="back">Назад</button>
        </div></div>`;
    }
    body.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => aiAction(b.dataset.a); });
    aiPlace(...ai.anchor);
    body.querySelector('.primary, [data-a="again"]')?.focus();
  }
  // Текст результата для надписи: без разметки Markdown, пункты — строками.
  const plainResult = (md) => mdPlain(md).split('\n').map((l) => l.replace(/^\s*[-*•–]\s+/, '').trimEnd()).join('\n').replace(/\n{2,}/g, '\n').trim();
  // Многострочный текст: \P — новый абзац; обратная косая черта и фигурные скобки экранируются.
  const toMtext = (s) => String(s).replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => '\\' + c).split('\n').join('\\P');
  async function aiAction(a) {
    if (a === 'back') { aiMenu(ai.pop.querySelector('.st-ai-input').value); ai.pop.querySelector('.st-ai-foot').hidden = false; return; }
    if (a === 'again') { aiRun(ai.op, ai.custom); return; }
    if (a === 'copy') {
      const text = mdPlain(ai.result);
      try { await navigator.clipboard.writeText(text); } catch {
        const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
        t.remove();
      }
      toast('Скопировано');
      return;
    }
    const sel = ai.sel || {};
    const text = plainResult(ai.result);
    try {
      await PC.exec('undo', { mode: 'begin' }).catch(() => {});
      try {
        if (a === 'replace') {
          const t = sel.texts[0];
          await PC.exec('textedit', { handle: t.handle, text: t.mtext ? toMtext(text) : text.replace(/\n+/g, ' ') });
        } else if (a === 'replaceEach') {
          const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines.length !== sel.texts.length) throw new Error(`модель вернула ${lines.length} строк вместо ${sel.texts.length}. Нажмите «Ещё вариант» или «Новой надписью ниже»`);
          for (let i = 0; i < lines.length; i++) {
            const t = sel.texts[i];
            await PC.exec('textedit', { handle: t.handle, text: t.mtext ? toMtext(lines[i]) : lines[i] });
          }
        } else if (a === 'newText') {
          let at; let height = 3.5; let width = 0;
          if (sel.texts && sel.texts.length) {
            const lowest = sel.texts.reduce((m, t) => (t.at && (!m || t.at[1] < m.at[1]) ? t : m), null) || sel.texts[0];
            height = Math.max(1.8, Math.min(14, lowest.height || 3.5));
            width = lowest.width || 0;
            at = [lowest.at[0], lowest.at[1] - height * 3];
          } else {
            const d = await PC.call('drawing.inspect', { entities: false });
            at = d.view ? P(d.view.center) : [0, 0];
          }
          const p = { at, text: toMtext(text), height };
          if (width > 0) p.width = width;
          const r = await PC.exec('mtext', p);
          const h = r && (r.handle || (Array.isArray(r.handles) && r.handles[0]));
          if (h) await PC.exec('select', { handles: [h] }).catch(() => {});
        }
      } finally {
        await PC.exec('undo', { mode: 'end' }).catch(() => {});
      }
      aiClose();
      toast('Готово. Отменить — Ctrl+Z');
    } catch (e) {
      toast('Не получилось: ' + e.message, true);
    }
  }
  window.addEventListener('aiautocad:ai', (e) => {
    const c = document.getElementById('cadcraft_canvas');
    const r = c ? c.getBoundingClientRect() : { left: 0, top: 0 };
    const d = e.detail || {};
    aiOpen(r.left + (Number(d.x) || 0), r.top + (Number(d.y) || 0));
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.altKey && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const c = document.getElementById('cadcraft_canvas');
      const r = c ? c.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
      aiOpen(r.left + Math.max(40, r.width / 2 - 200), r.top + Math.max(80, r.height / 4));
    }
  }, true);
  document.addEventListener('pointerdown', (e) => { if (ai.pop && !ai.pop.contains(e.target) && !ai.abort) aiClose(); }, true);

  // ------------------------------------------------------------------ тема
  // Тема редактора: фирменная (по умолчанию), светлая или тёмная. Панель — в тон.
  const THEMES = [['brand', 'Фирменная'], ['light', 'Светлая'], ['dark', 'Тёмная']];
  const systemDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function applyPanelTheme(themeId) {
    root.dataset.theme = themeId === 'brand' ? 'brand' : (themeId === 'dark' || (themeId === 'system' && systemDark()) ? 'dark' : 'light');
    document.documentElement.classList.toggle('studio-brand', themeId === 'brand');
    renderThemeMenu(themeId);
  }
  const syncBackdrop = () => {};
  function renderThemeMenu(current) {
    const menu = $('themeMenu');
    if (!menu) return;
    menu.innerHTML = THEMES.map((t) => `<button role="menuitemradio" aria-checked="${t[0] === current}" data-theme-id="${t[0]}">${esc(t[1])}</button>`).join('');
    menu.querySelectorAll('button').forEach((b) => { b.onclick = () => { toggleThemeMenu(false); setTheme(b.dataset.themeId); }; });
  }
  function toggleThemeMenu(open) {
    const menu = $('themeMenu');
    if (!menu) return;
    const show = open == null ? menu.hidden : open;
    menu.hidden = !show;
    $('theme').setAttribute('aria-expanded', String(show));
  }
  async function setTheme(themeId) {
    applyPanelTheme(themeId);
    store.set('theme', themeId);
    if (PC.ready()) await PC.exec('ui.theme', { theme: themeId }).catch(() => {});
  }
  // Тема, которая сейчас в редакторе, как бы её ни выбрали (Окно › Яркость интерфейса, список в панели).
  async function watchTheme() {
    for (;;) {
      if (!document.hidden && PC.ready()) {
        try {
          const ui = await PC.call('ui.inspect');
          const id = ui && ui.ui && ui.ui.theme;
          // Фирменная, светлая, тёмная; «как в системе» панель показывает по теме, которую видно.
          if (typeof id === 'string') {
            const b = id.toLowerCase();
            applyPanelTheme(b === 'brand' ? 'brand' : b === 'system' ? (ui.theme === 'light' ? 'light' : 'dark') : (b === 'dark' ? 'dark' : 'light'));
          }
        } catch { /* не важно */ }
      }
      await sleep(2000);
    }
  }

  async function status() {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin' });
      const j = await r.json();
      if (j.ok) {
        if (Number(j.ctx) > 0) CTX = Number(j.ctx);
        if (j.source) $('sub').title = 'Откуда взята модель: ' + j.source;
        $('sub').textContent = 'Модель: ' + j.model;
        fetch('studio/version.json', { cache: 'no-store' }).then((v) => (v.ok ? v.json() : null)).then((v) => {
          if (!v || !v.build) return;
          const d = String(v.date || '').split('-').reverse().join('.');
          $('sub').textContent = 'Модель: ' + j.model + ' · сборка ' + v.build + (d ? ' от ' + d : '');
          const pageBuild = document.documentElement.dataset.build;
          if (pageBuild && pageBuild !== String(v.build)) {
            const page = +pageBuild, server = +v.build;
            if (page > server) {
              msg('note', `Страница — от сборки ${esc(pageBuild)}, а файлы на сервере частично остались от сборки ${esc(String(v.build))}: ` +
                'программа заливки, похоже, пропустила файлы того же размера. Удалите старую папку на сервере целиком и залейте новую ' +
                '(или включите в программе «перезаписывать всегда»).');
            } else {
              msg('note', `Открыта старая копия страницы из кэша браузера (сборка ${esc(pageBuild)}), а на сервере уже сборка ${esc(String(v.build))}. Нажмите <b>Ctrl+F5</b>, чтобы загрузить новую.`);
            }
          }
        }).catch(() => {});
      }
      else $('sub').textContent = j.login ? 'Нужно войти в систему' : (j.error || 'Нет связи с помощником');
    } catch {
      $('sub').textContent = 'Нет связи с сервером помощника';
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; }

  function mount() {
    document.body.appendChild(root);
    root.querySelectorAll('.st-seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $('eye').onclick = () => setEye(!attachScreen);
    initAgentMenu();
    $('hide').onclick = () => setOpen(false);
    $('fab').onclick = () => { setOpen(true); setBadge(false); };
    $('send').onclick = () => send();
    $('barBtn').onclick = () => setBar(!root.classList.contains('bar-open'));
    $('barSend').onclick = () => (busy ? send() : sendFromBar());
    $('barMode').onclick = () => setMode(mode === 'act' ? 'advice' : 'act');
    barInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendFromBar(); }
      if (e.key === 'Escape') { e.preventDefault(); setBar(false); }
    });
    $('clear').onclick = () => { if (!busy) { convo = []; showEmpty(); } };
    // Луна/солнце — между светлой и тёмной неоморфными; из фирменной — в светлую.
    $('theme').onclick = (e) => { e.stopPropagation(); toggleThemeMenu(); };
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest || !e.target.closest('.st-theme-wrap')) toggleThemeMenu(false); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleThemeMenu(false); });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    setMode(mode);
    setEye(attachScreen);
    applyPanelTheme('brand');
    showEmpty();
    status();
  }

  async function boot() {
    mount();
    // Ждём, пока WebAssembly загрузится и поставит window.aiautocad, а редактор запустится и начнёт отвечать.
    while (!PC.ready()) await sleep(200);
    for (let i = 0; i < 600; i++) {
      try { await PC.call('ui.inspect'); break; } catch { await sleep(300); }
    }
    Files.start();
    // Тема, выбранная в этом браузере раньше (редактор каждый раз начинает с фирменной).
    const saved = store.get('theme', 'brand');
    if (saved !== 'brand') setTheme(saved);
    // Шрифты — до того, как пользователь откроет чертёж (открытые потом перерисуются).
    const fonts = Fonts.start();
    await sleep(300);
    root.classList.add('ready');
    if (store.get('open', CFG.openOnStart)) {
      setOpen(true);
      // Окно чертежа стало уже: весь чертёж — в окне.
      setTimeout(() => PC.exec('zoom.extents').catch(() => {}), 700);
    }
    commands().catch(() => {});
    watchTheme();
    Gallery.start();
    fonts.then((n) => { if (n) console.info('AI-AutoCAD: шрифтов загружено', n); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
