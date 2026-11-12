/* AI Чертежи — проверка DWG в отдельном экземпляре редактора (Web Worker).
 *
 * В браузере сбой внутри стороннего читателя DWG нельзя перехватить: он останавливает весь
 * редактор. Поэтому перед открытием DWG страница (studio.js, window.aiautocadCheckDwg) читает файл
 * здесь, в отдельной копии того же модуля WebAssembly. Если чтение остановилось — пострадал только
 * этот поток, а редактор сообщает «Файл повреждён или не поддерживается».
 *
 * Сообщения: на входе {loader, module, name, bytes}; на выходе {stage: 'init', error} — проверка
 * не запустилась (файл откроется как обычно), {stage: 'ready'}, затем {stage: 'done', ok, error?}.
 */
self.onmessage = async (e) => {
  const { loader, module, name, bytes } = e.data || {};
  let app;
  try {
    app = await import(loader);
    await app.default({ module_or_path: module });
  } catch (err) {
    self.postMessage({ stage: 'init', error: String((err && err.message) || err) });
    return;
  }
  self.postMessage({ stage: 'ready' });
  try {
    app.checkDrawing(String(name || 'drawing.dwg'), bytes);
    self.postMessage({ stage: 'done', ok: true });
  } catch (err) {
    self.postMessage({ stage: 'done', ok: false, error: String((err && err.message) || err) });
  }
};
