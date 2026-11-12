<?php
// studio/api/files.php — «Мои чертежи» AI Чертежи на вашем сервере. У каждого пользователя своя папка.
//
//   GET  files.php                          → {ok, user, files: [{name, size, modified}], limit}
//   GET  files.php?action=load&name=…       → сам чертёж (.dwg, .dxf, .dwt), application/octet-stream
//   POST files.php?action=save&name=…[&overwrite=1]   тело — байты файла → {ok, name, size, modified}
//   POST files.php?action=rename  {name, to}   → {ok}
//   POST files.php?action=delete  {name}       → {ok}  (файл уходит в корзину .trash/ папки пользователя)
//   GET  files.php?action=fonts             → {ok, fonts: [{name, size}]} — шрифты организации
//   GET  files.php?action=font&name=…       → сам шрифт
//
// Шрифты организации: папка fonts рядом с папками пользователей (storage/ai-autocad/fonts). Положите
// туда шрифты, на которые у организации есть лицензия: TrueType (.ttf, .otf) и чертёжные SHX (.shx,
// например шрифты по ГОСТ 2.304, которыми сделаны чертежи предприятия): AI Чертежи будет рисовать ими
// надписи у всех пользователей.
//
// Где лежат файлы: AI_AUTOCAD_DATA_DIR из .env, иначе storage/ai-autocad рядом с корнем сайта
// (/app/storage/ai-autocad при корне /app/src — вне корня, nginx её не отдаёт; создаётся сама),
// потом data/ai-autocad, а если никуда нельзя писать — ai-autocad-data рядом с папкой приложения
// (закройте её в nginx: см. nginx.conf.example).
// Имена файлов на диске случайные, список — в index.json папки пользователя.

declare(strict_types=1);

header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

function files_fail(int $http, string $message, array $extra = []): void
{
    http_response_code($http);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $message] + $extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function files_ok(array $data): void
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true] + $data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

ini_set('display_errors', '0');
set_exception_handler(static function (Throwable $e): void {
    error_log('ai-autocad files: ' . $e->getMessage());
    files_fail(500, 'Внутренняя ошибка хранилища файлов. Подробности — в журнале PHP.');
});

require_once __DIR__ . '/llm.php';
$STUDIO = require __DIR__ . '/settings.php';

// ---------------------------------------------------------------- кто это
$user = 'local';
if ($STUDIO['auth_file'] !== '' && is_file($STUDIO['auth_file'])) {
    require_once $STUDIO['auth_file'];
    if (!function_exists('isLoggedIn') || !isLoggedIn()) {
        files_fail(401, 'Войдите в систему, чтобы открыть свои файлы.', ['login' => true]);
    }
    $u = function_exists('getCurrentUser') ? getCurrentUser() : null;
    $id = is_array($u) ? ($u['id'] ?? $u['login'] ?? null) : null;
    if ($id === null || $id === '') {
        files_fail(500, 'auth.php не сообщил, кто вошёл (getCurrentUser).');
    }
    $user = (string)$id;
} elseif (!$STUDIO['allow_anonymous']) {
    files_fail(500, 'Не найден auth.php системы. Укажите путь в AI_AUTOCAD_AUTH_FILE (см. README.ru.md).');
}
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

// ---------------------------------------------------------------- где лежат файлы
function files_root(): string
{
    $env = studio_env('AI_AUTOCAD_DATA_DIR');
    if ($env !== '') {
        return rtrim($env, '/');
    }
    // Рядом с корнем сайта, но не внутри него: сначала папка storage (как /app/storage при корне
    // /app/src — туда же nginx пишет журналы), потом data. Берётся первая, куда PHP может писать.
    $docRoot = rtrim((string)($_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
    $parent = $docRoot !== '' ? dirname($docRoot) : '';
    $candidates = [];
    if ($parent !== '' && $parent !== '/' && is_dir("$parent/storage")) {
        $candidates[] = "$parent/storage/ai-autocad";
    }
    if ($parent !== '' && $parent !== '/') {
        $candidates[] = "$parent/data/ai-autocad";
    }
    foreach ($candidates as $dir) {
        if ((is_dir($dir) && is_writable($dir)) || (!is_dir($dir) && @mkdir($dir, 0770, true))) {
            return $dir;
        }
    }
    return dirname(__DIR__, 2) . '/ai-autocad-data';
}

$root = files_root();
if (!is_dir($root) && !@mkdir($root, 0770, true) && !is_dir($root)) {
    files_fail(500, "Не удалось создать папку для файлов: $root. Создайте её и дайте PHP право записи (или укажите AI_AUTOCAD_DATA_DIR).");
}
// Если папка всё же внутри сайта — закрываем её для Apache и не даём листать.
if (!is_file("$root/.htaccess")) {
    @file_put_contents("$root/.htaccess", "Require all denied\n");
}
if (!is_file("$root/index.html")) {
    @file_put_contents("$root/index.html", '');
}
$dir = $root . '/u-' . preg_replace('/[^A-Za-z0-9_-]/', '_', $user);
if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
    files_fail(500, 'Не удалось создать папку пользователя. Проверьте права PHP на ' . $root);
}

const FILES_MAX_BYTES = 512 * 1024 * 1024;
const FILES_MAX_COUNT = 2000;
/** Типы чертежей, которые хранятся (расширение имени на сервере и на диске). */
// .dwg — чертёж AutoCAD (по умолчанию), .dxf — обменный формат (родной формат CADCraft, текстовый
// или двоичный), .dwt — шаблон (тот же DWG).
const FILES_EXTS = ['dwg', 'dxf', 'dwt'];
const FILES_STORED = '/^[0-9a-f]{32}\.(dwg|dxf|dwt)$/';
/** Начало двоичного DXF. */
const DXF_BINARY_SIGNATURE = "AutoCAD Binary DXF";
const FONTS_EXTS = '/\.(ttf|otf|ttc|shx)$/i';
const FONTS_MAX_BYTES = 64 * 1024 * 1024;
const FONTS_MAX_COUNT = 200;

/** Расширение документа по имени, в нижнем регистре ('' — неизвестное). */
function files_ext(string $name): string
{
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    return in_array($ext, FILES_EXTS, true) ? $ext : '';
}

/** Похоже ли начало файла на DWG: «AC10» и ещё две цифры (версия формата). */
function files_is_dwg(string $head): bool
{
    return preg_match('/^AC10[0-9]{2}/', $head) === 1;
}

/** Похоже ли начало файла на DXF: двоичный по подписи, текстовый — код 0 или 999 первой строкой. */
function files_is_dxf(string $head): bool
{
    if (strncmp($head, DXF_BINARY_SIGNATURE, strlen(DXF_BINARY_SIGNATURE)) === 0) {
        return true;
    }
    if (str_contains($head, "\0")) {
        return false;
    }
    $text = preg_replace('/^\xEF\xBB\xBF/', '', $head) ?? '';
    return preg_match('/^\s*(0|999)\s*\r?\n/', $text) === 1;
}

/** Папка шрифтов организации (создаётся сама, с подсказкой внутри). */
function fonts_dir(string $root): string
{
    $dir = "$root/fonts";
    if (!is_dir($dir)) {
        @mkdir($dir, 0770, true);
        @file_put_contents("$dir/README.txt", "Положите сюда шрифты, на которые у организации есть лицензия (.ttf, .otf),\n"
            . "и чертёжные шрифты SHX (.shx), например шрифты по ГОСТ 2.304, которыми сделаны чертежи предприятия.\n"
            . "AI Чертежи загрузит их у всех пользователей, и надписи на чертежах будут теми же шрифтами.\n");
    }
    return $dir;
}

/** Имя файла, как его видит пользователь: без путей и служебных символов. */
function files_name(?string $name): string
{
    $name = trim((string)$name);
    $name = preg_replace('/[\x00-\x1F\x7F\/\\\\]+/u', ' ', $name) ?? '';
    $name = trim(preg_replace('/\s+/u', ' ', $name) ?? '');
    if ($name === '' || $name === '.' || $name === '..') {
        files_fail(400, 'Пустое имя файла.');
    }
    if (mb_strlen($name) > 120) {
        $name = mb_substr($name, 0, 120);
    }
    // Чертёж без известного расширения сохраняется как DWG.
    if (files_ext($name) === '') {
        $name .= '.dwg';
    }
    return $name;
}

/** Список файлов пользователя под блокировкой: $fn меняет его и возвращает результат. */
function files_index(string $dir, callable $fn)
{
    $lock = fopen("$dir/index.lock", 'c');
    if ($lock === false) {
        files_fail(500, 'Не удалось открыть список файлов.');
    }
    flock($lock, LOCK_EX);
    try {
        $raw = is_file("$dir/index.json") ? file_get_contents("$dir/index.json") : '';
        $index = $raw ? json_decode($raw, true) : [];
        if (!is_array($index)) {
            $index = [];
        }
        $before = $index;
        $result = $fn($index);
        if ($index !== $before) {
            $tmp = "$dir/index.json." . bin2hex(random_bytes(4));
            file_put_contents($tmp, json_encode($index, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            rename($tmp, "$dir/index.json");
        }
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function files_json_body(): array
{
    $j = json_decode((string)file_get_contents('php://input'), true);
    return is_array($j) ? $j : [];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = (string)($_GET['action'] ?? ($method === 'GET' ? 'list' : ''));

switch ($action) {
    case 'list':
        $files = files_index($dir, static function (array &$index): array {
            $out = [];
            foreach ($index as $name => $f) {
                $out[] = ['name' => (string)$name, 'size' => (int)($f['size'] ?? 0), 'modified' => (int)($f['modified'] ?? 0)];
            }
            usort($out, static fn($a, $b) => $b['modified'] <=> $a['modified']);
            return $out;
        });
        files_ok(['user' => $user, 'files' => $files, 'limit' => FILES_MAX_BYTES]);

    case 'load':
        $name = files_name($_GET['name'] ?? '');
        $file = files_index($dir, static fn(array &$index) => $index[$name]['file'] ?? null);
        if (!is_string($file) || !preg_match(FILES_STORED, $file) || !is_file("$dir/$file")) {
            files_fail(404, "Файла «{$name}» нет.");
        }
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . filesize("$dir/$file"));
        readfile("$dir/$file");
        exit;

    case 'save':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $name = files_name($_GET['name'] ?? '');
        $overwrite = ($_GET['overwrite'] ?? '') === '1';
        $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($declared > FILES_MAX_BYTES) {
            files_fail(413, 'Файл больше 512 МБ.');
        }
        $tmp = "$dir/upload." . bin2hex(random_bytes(6));
        $in = fopen('php://input', 'rb');
        $out = fopen($tmp, 'wb');
        $size = ($in && $out) ? stream_copy_to_stream($in, $out, FILES_MAX_BYTES + 1) : false;
        if ($in) fclose($in);
        if ($out) fclose($out);
        if ($size === false || $size === 0) {
            @unlink($tmp);
            files_fail(400, $declared > 0
                ? 'Сервер не передал PHP содержимое файла. Скорее всего, файл больше post_max_size в настройках PHP — увеличьте post_max_size и upload_max_filesize.'
                : 'Пустой файл.');
        }
        if ($size > FILES_MAX_BYTES) {
            @unlink($tmp);
            files_fail(413, 'Файл больше 512 МБ.');
        }
        // .dwg/.dwt начинаются с версии формата «AC10…» (AC1015 — 2000, AC1032 — 2018), двоичный
        // .dxf — с «AutoCAD Binary DXF», текстовый .dxf — с кода группы 0 (или 999, комментарий)
        // на первой строке, и в нём нет нулевых байтов.
        $ext = files_ext($name);
        $head = (string)file_get_contents($tmp, false, null, 0, 4096);
        $ok = match ($ext) {
            'dwg', 'dwt' => files_is_dwg($head),
            'dxf' => files_is_dxf($head),
            default => false,
        };
        if (!$ok) {
            @unlink($tmp);
            files_fail(400, 'Содержимое не похоже на чертёж .' . $ext . '.');
        }
        $saved = files_index($dir, static function (array &$index) use ($dir, $name, $overwrite, $tmp, $size) {
            if (isset($index[$name]) && !$overwrite) {
                return ['exists' => true];
            }
            if (!isset($index[$name]) && count($index) >= FILES_MAX_COUNT) {
                return ['full' => true];
            }
            $old = (string)($index[$name]['file'] ?? '');
            $file = preg_match(FILES_STORED, $old) ? $old : (bin2hex(random_bytes(16)) . '.' . files_ext($name));
            if (!rename($tmp, "$dir/$file")) {
                return ['error' => true];
            }
            $index[$name] = ['file' => $file, 'size' => $size, 'modified' => time()];
            return ['modified' => $index[$name]['modified']];
        });
        if (!empty($saved['exists']) || !empty($saved['full']) || !empty($saved['error'])) {
            @unlink($tmp);
        }
        if (!empty($saved['exists'])) {
            files_fail(409, "Файл «{$name}» уже есть.", ['exists' => true]);
        }
        if (!empty($saved['full'])) {
            files_fail(507, 'Слишком много файлов. Удалите ненужные.');
        }
        if (!empty($saved['error'])) {
            files_fail(500, 'Не удалось записать файл на сервер. Проверьте права PHP на ' . $dir);
        }
        files_ok(['name' => $name, 'size' => $size, 'modified' => $saved['modified']]);

    case 'rename':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $body = files_json_body();
        $name = files_name($body['name'] ?? '');
        $to = files_name($body['to'] ?? '');
        $r = files_index($dir, static function (array &$index) use ($name, $to) {
            if (!isset($index[$name])) return 'missing';
            if ($name === $to) return 'ok';
            if (isset($index[$to])) return 'exists';
            $index[$to] = $index[$name];
            unset($index[$name]);
            return 'ok';
        });
        if ($r === 'missing') files_fail(404, "Файла «{$name}» нет.");
        if ($r === 'exists') files_fail(409, "Файл «{$to}» уже есть.", ['exists' => true]);
        files_ok(['name' => $to]);

    case 'delete':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $name = files_name(files_json_body()['name'] ?? '');
        $r = files_index($dir, static function (array &$index) use ($dir, $name) {
            if (!isset($index[$name])) return false;
            $file = (string)($index[$name]['file'] ?? '');
            if (preg_match(FILES_STORED, $file) && is_file("$dir/$file")) {
                @mkdir("$dir/.trash", 0770);
                @rename("$dir/$file", "$dir/.trash/" . date('Ymd-His') . '-' . $file);
            }
            unset($index[$name]);
            return true;
        });
        if (!$r) files_fail(404, "Файла «{$name}» нет.");
        files_ok([]);

    case 'fonts':
        $fdir = fonts_dir($root);
        $fonts = [];
        foreach (scandir($fdir) ?: [] as $f) {
            if (preg_match(FONTS_EXTS, $f) && is_file("$fdir/$f") && filesize("$fdir/$f") <= FONTS_MAX_BYTES) {
                $fonts[] = ['name' => $f, 'size' => filesize("$fdir/$f")];
            }
            if (count($fonts) >= FONTS_MAX_COUNT) {
                break;
            }
        }
        files_ok(['fonts' => $fonts]);

    case 'font':
        $f = basename((string)($_GET['name'] ?? ''));
        $path = fonts_dir($root) . '/' . $f;
        if ($f === '' || $f[0] === '.' || !preg_match(FONTS_EXTS, $f) || !is_file($path) || filesize($path) > FONTS_MAX_BYTES) {
            files_fail(404, 'Нет такого шрифта.');
        }
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . filesize($path));
        header('Cache-Control: private, max-age=86400');
        readfile($path);
        exit;

    default:
        files_fail(400, 'Неизвестное действие.');
}
