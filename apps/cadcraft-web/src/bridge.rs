//! `window.aiautocad`: AI Чертежи's page bridge.
//!
//! The assistant panel next to the editor (`studio/`) drives the app with the same JSON methods as
//! the desktop control channel (`docs/control-protocol.md`), so it uses the commands the CLI and the
//! MCP server use:
//!
//! ```js
//! await aiautocad.execute("line", {points: [[0, 0], [100, 0]]})   // a command with JSON params
//! await aiautocad.request("cmdline.input", {text: "circle 0,0 25"})  // any control method
//! await aiautocad.commands()                                     // every command with its params doc
//! await aiautocad.inspect()                                      // the drawing (drawing.inspect)
//! await aiautocad.uiInspect()                                    // the interface (ui.inspect)
//! const {data} = await aiautocad.screenshot()                    // the window as PNG (base64)
//! aiautocad.open("План.dwg", bytes)                              // open a drawing (Uint8Array)
//! await aiautocad.addFont("LiberationSans-Regular.ttf", bytes)    // a font for drawing text
//! aiautocad.wantsKeyboard()                                      // a text field has the keyboard
//! ```
//!
//! `request`, `execute`, `commands`, `docInspect`, `uiInspect` and `screenshot` come from the shared
//! page API (`craft-web-api`); the rest is AI Чертежи's. Results resolve with the method's
//! `result`; errors reject with an `Error`.
//!
//! Events on `window`: `aiautocad:save` (`detail: {name, path, saveAs, bytes}`) for a drawing saved
//! while `aiautocad.takesSaves` is true (the page keeps it in «Мои чертежи» on the server; exports
//! and plots still download), `aiautocad:dirty` (`detail: {dirty}`) when unsaved changes appear or
//! go away, and `aiautocad:ai` (`detail: {x, y}`, CSS pixels from the canvas's top left) when the
//! AI button or the drawing area's «ИИ у выделения…» asks for the page's AI menu.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, channel};

use cadcraft_ui_egui::{ControlRequest, PendingReply};
use craft_web_api::methods::Methods;
use craft_web_api::page::{PageApi, Request};
use serde_json::{Value, json};
use wasm_bindgen::JsCast as _;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

/// The global name: `window.aiautocad`, events `aiautocad:<what>`.
const APP: &str = "aiautocad";

/// How often a waiting call looks for the app's reply, in milliseconds (about a frame).
const POLL_MS: i32 = 16;

/// The largest drawing or font the page may hand over at once.
const MAX_FILE_BYTES: u32 = 512 * 1024 * 1024;

/// Drawing files a save hands to the page; every other file (plots, exports) downloads.
const DRAWING_EXTS: &[&str] = &["dwg", "dxf", "dwt"];

struct Link {
    inbox: crate::upload::Inbox,
    ctx: egui::Context,
}

thread_local! {
    static LINK: RefCell<Option<Link>> = const { RefCell::new(None) };
}

/// Put `window.aiautocad` on the page and return the queue the app drains each frame (hand it to
/// `CadApp::with_control`). Drawings the page opens arrive through `inbox`.
pub fn install(ctx: egui::Context, inbox: crate::upload::Inbox) -> Receiver<ControlRequest> {
    LINK.with(|l| *l.borrow_mut() = Some(Link { inbox, ctx: ctx.clone() }));
    let (queue, requests) = channel::<ControlRequest>();
    let wake = ctx.clone();
    let request: Request = Rc::new(move |method, params| {
        let (control, reply) = ControlRequest::new(method, params);
        if queue.send(control).is_err() {
            return Box::pin(async { json!({"ok": false, "error": "AI Чертежи не запущен"}) });
        }
        wake.request_repaint();
        Box::pin(wait(reply))
    });
    if let Err(e) = own_functions(request.clone()) {
        log::warn!("couldn't install window.{APP}: {e:?}");
    }
    let methods = Methods { doc_inspect: Some("drawing.inspect"), ..Methods::default() };
    if let Err(e) = Rc::new(PageApi::new(APP, methods, request).with_timeout(120_000)).install() {
        log::warn!("couldn't install window.{APP}: {e:?}");
    }
    requests
}

/// The app's reply, polled about once a frame. Dropping this future (the page's timeout) drops
/// `reply`, which cancels the request if the app has not started it.
async fn wait(reply: PendingReply) -> Value {
    loop {
        if let Some(reply) = reply.try_reply() {
            return reply;
        }
        sleep(POLL_MS).await;
    }
}

async fn sleep(ms: i32) {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms);
        }
    });
    let _ = JsFuture::from(promise).await;
}

fn to_js(v: &Value) -> JsValue {
    js_sys::JSON::parse(&v.to_string()).unwrap_or(JsValue::NULL)
}

fn from_js(v: &JsValue) -> Value {
    if v.is_undefined() || v.is_null() {
        return json!({});
    }
    js_sys::JSON::stringify(v).ok().and_then(|s| s.as_string()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

fn error(message: &str) -> JsValue {
    js_sys::Error::new(message).into()
}

fn set(obj: &js_sys::Object, name: &str, f: JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &name.into(), &f).map(|_| ())
}

/// `window.aiautocad` with AI Чертежи's own functions; the shared page API adds the rest to it.
fn own_functions(request: Request) -> Result<(), JsValue> {
    let obj = js_sys::Object::new();
    let inspect = request.clone();
    set(
        &obj,
        "inspect",
        Closure::<dyn Fn(JsValue) -> js_sys::Promise>::new(move |params: JsValue| {
            let call = inspect("drawing.inspect".to_string(), from_js(&params));
            wasm_bindgen_futures::future_to_promise(async move {
                let reply = call.await;
                if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(to_js(reply.get("result").unwrap_or(&Value::Null)))
                } else {
                    Err(error(reply.get("error").and_then(Value::as_str).unwrap_or("the request failed")))
                }
            })
        })
        .into_js_value(),
    )?;
    set(&obj, "open", Closure::<dyn Fn(String, JsValue) -> Result<(), JsValue>>::new(open).into_js_value())?;
    set(&obj, "addFont", Closure::<dyn Fn(String, JsValue) -> Result<JsValue, JsValue>>::new(add_font).into_js_value())?;
    set(
        &obj,
        "wantsKeyboard",
        Closure::<dyn Fn() -> bool>::new(|| LINK.with(|l| l.borrow().as_ref().is_some_and(|link| link.ctx.text_edit_focused()))).into_js_value(),
    )?;
    set(&obj, "takesSaves", JsValue::FALSE)?;
    set(&obj, "product", JsValue::from_str("AI Чертежи"))?;
    let w = web_sys::window().ok_or("no window")?;
    js_sys::Reflect::set(&w, &APP.into(), &obj)?;
    Ok(())
}

/// The bytes of a `Uint8Array` or `ArrayBuffer`, within [`MAX_FILE_BYTES`].
fn bytes_of(v: &JsValue) -> Result<Vec<u8>, JsValue> {
    let array = if let Some(a) = v.dyn_ref::<js_sys::Uint8Array>() {
        a.clone()
    } else if v.is_instance_of::<js_sys::ArrayBuffer>() {
        js_sys::Uint8Array::new(v)
    } else {
        return Err(error("bytes must be a Uint8Array or an ArrayBuffer"));
    };
    if array.length() > MAX_FILE_BYTES {
        return Err(error("the file is too large"));
    }
    Ok(array.to_vec())
}

/// Open a drawing the page has (from «Мои чертежи» on the server) in a tab of its own, on the next
/// frame, as a file picked with File › Open is. An SHX font is registered for the drawings' text.
fn open(name: String, bytes: JsValue) -> Result<(), JsValue> {
    let bytes = bytes_of(&bytes)?;
    let name = crate::clean_name(&name, "Чертеж.dwg");
    LINK.with(|l| {
        let link = l.borrow();
        let link = link.as_ref().ok_or_else(|| error("AI Чертежи ещё не запустился"))?;
        link.inbox.receive(name, bytes);
        link.ctx.request_repaint();
        Ok(())
    })
}

/// Add a TrueType font for drawing text (the metric-compatible fonts shipped with the page, and
/// the fonts an organisation keeps on its server), or an SHX font. Resolves with `{faces}`. Call
/// `execute("regenall")` after the last one, so open drawings are drawn again with them.
///
/// The Liberation fonts also answer for the fonts they stand in for (Arial, Times New Roman,
/// Courier New), and Liberation Sans becomes the substitute for missing fonts (FONTALT) and the
/// fallback for characters a font lacks (FONTFALLBACK) unless those are set: the built-in drafting
/// font has no Cyrillic, and the browser has no system fonts.
fn add_font(name: String, bytes: JsValue) -> Result<JsValue, JsValue> {
    let bytes = bytes_of(&bytes)?;
    let name = crate::clean_name(&name, "font.ttf");
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".shx") {
        cadcraft_fonts::shx::register(&name, &bytes).map_err(|e| error(&format!("{name}: {e}")))?;
        repaint();
        return Ok(to_js(&json!({ "faces": 1 })));
    }
    let stem = lower.trim_end_matches(".ttf").trim_end_matches(".otf").to_string();
    for alias in crate::font_aliases(&stem) {
        cadcraft_fonts::ttf::register(alias, bytes.clone());
    }
    cadcraft_fonts::ttf::register(&name, bytes);
    if stem == "liberationsans-regular" {
        if cadcraft_fonts::ttf::font_alt().is_empty() {
            cadcraft_fonts::ttf::set_font_alt(&name);
        }
        if cadcraft_fonts::ttf::fallback_fonts().is_empty() {
            cadcraft_fonts::ttf::set_fallback_fonts(&name);
        }
    }
    repaint();
    Ok(to_js(&json!({ "faces": 1 })))
}

fn repaint() {
    LINK.with(|l| {
        if let Some(link) = l.borrow().as_ref() {
            link.ctx.request_repaint();
        }
    });
}

/// Tell the page something happened (`aiautocad:<what>` on `window`, with `detail`).
fn notify(what: &str, detail: &JsValue) -> Result<(), String> {
    let window = web_sys::window().ok_or("no window")?;
    let init = web_sys::CustomEventInit::new();
    init.set_detail(detail);
    let event = web_sys::CustomEvent::new_with_event_init_dict(&format!("{APP}:{what}"), &init).map_err(|e| format!("{e:?}"))?;
    window.dispatch_event(&event).map(|_| ()).map_err(|e| format!("{e:?}"))
}

/// Whether the page said it takes saves (`aiautocad.takesSaves = true`).
fn takes_saves() -> bool {
    web_sys::window()
        .and_then(|w| js_sys::Reflect::get(&w, &APP.into()).ok())
        .and_then(|o| js_sys::Reflect::get(&o, &"takesSaves".into()).ok())
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// The engine's delivery hook: a saved drawing goes to the page while it takes saves (it keeps
/// the drawing in «Мои чертежи» on the server, and downloads it if the server refuses); plots,
/// exports and every save without the page download.
pub fn deliver(name: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    if crate::is_drawing_name(name, DRAWING_EXTS) && takes_saves() {
        let detail = js_sys::Object::new();
        let put = |k: &str, v: &JsValue| js_sys::Reflect::set(&detail, &k.into(), v).map(|_| ()).map_err(|e| format!("{e:?}"));
        put("name", &name.into())?;
        put("path", &JsValue::NULL)?;
        put("saveAs", &JsValue::FALSE)?;
        put("bytes", &js_sys::Uint8Array::from(bytes).into())?;
        return notify("save", &detail.into());
    }
    crate::download::download(name, mime, bytes)
}

/// Ask the page to open its AI menu at this point of the window (egui points from its top left):
/// `aiautocad:ai` with `detail: {x, y}` in CSS pixels.
pub fn ai_menu(x: f32, y: f32) {
    let zoom = LINK.with(|l| l.borrow().as_ref().map_or(1.0, |link| link.ctx.zoom_factor()));
    let _ = notify("ai", &to_js(&json!({ "x": x * zoom, "y": y * zoom })));
}

/// Whether a drawing has unsaved changes, told to the page when it changes.
pub fn dirty(now: bool) {
    thread_local! {
        static LAST: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
    }
    if LAST.with(|l| l.replace(Some(now))) != Some(now) {
        let _ = notify("dirty", &to_js(&json!({ "dirty": now })));
    }
}

/// Leave the editor for the site it lives on: `window.STUDIO_CONFIG.homeUrl` (studio/config.js,
/// made absolute by the panel), one level up without it.
pub fn go_home() {
    let Some(window) = web_sys::window() else { return };
    let url = js_sys::Reflect::get(&window, &"STUDIO_CONFIG".into())
        .ok()
        .filter(|c| c.is_object())
        .and_then(|c| js_sys::Reflect::get(&c, &"homeUrl".into()).ok())
        .and_then(|u| u.as_string())
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "../".to_string());
    if let Err(e) = window.location().set_href(&url) {
        log::error!("couldn't go to {url}: {e:?}");
    }
}
