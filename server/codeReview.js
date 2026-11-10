/**
 * ============================================================
 *  C 代码体检引擎  codeReview.js
 * ------------------------------------------------------------
 *  设计目标：不靠「让大模型看一眼代码」来判对错，而是先拿到
 *  四层客观证据，再让 AI 只负责把证据翻译成学习建议。
 *
 *    第 1 层  编译期     gcc/clang -Wall -Wextra  → error / warning（含中文化）
 *    第 2 层  运行期     真实执行 + stdin         → stdout / 退出码 / 段错误
 *    第 3 层  内存与 UB  -fsanitize=address,undefined → 越界 / 悬垂 / 溢出
 *    第 4 层  行为验证   期望输出比对 + 静态风险扫描（十余条 C 专属规则）
 *
 *  这四层都是 C 语言特有的问题域（编译期报错、Segmentation fault、
 *  指针与内存、未定义行为），换成 Python 完全不成立 —— 也就是这个模块
 *  用来体现「解决 C 语言问题能力」的核心。
 *
 *  降级策略：没有 gcc → 静态扫描 + AI 照常工作；
 *            编译器不支持 Sanitizer → 自动跳过并用静态规则补位；
 *            Ollama 没启动 → 只输出客观体检报告，不白屏。
 *
 *  零新增 npm 依赖：child_process / fs / os / path 均为 Node 内置，
 *  multer 复用 server 目录已安装的包。
 * ============================================================
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = 'qwen3:4b';

const MAX_CODE = 20000;        // 单次体检代码上限（字符）
const MAX_OUTPUT = 8000;       // 程序输出截断，防止死循环刷屏
const COMPILE_TIMEOUT = 8000;  // 编译超时 ms
const RUN_TIMEOUT = 2000;      // 运行超时 ms（防 while(1)）
const AI_TIMEOUT = 45000;      // AI 诊断超时 ms（本地小模型首次加载偏慢，且已改为异步不阻塞）
const MAX_CONCURRENCY = 3;     // 同时最多 3 个编译任务

let activeJobs = 0;
let gccCommand = undefined;    // undefined=未探测 / string=可用 / null=不可用
let sanitizerSupported = undefined; // undefined=未探测 / true / false

// ---------------------------------------------------------------
// 1. 编译器探测
// ---------------------------------------------------------------
function detectGcc() {
    if (gccCommand !== undefined) return gccCommand;
    const candidates = [
        process.env.C_GCC,
        'gcc',
        'C:/msys64/mingw64/bin/gcc.exe',
        'C:/msys64/ucrt64/bin/gcc.exe',
        'C:/mingw64/bin/gcc.exe',
        'C:/MinGW/bin/gcc.exe',
        'C:/TDM-GCC-64/bin/gcc.exe',
        'C:/Program Files/Dev-Cpp/MinGW64/bin/gcc.exe',
        'C:/Program Files (x86)/Dev-Cpp/MinGW64/bin/gcc.exe',
        '/usr/bin/gcc',
        '/usr/local/bin/gcc',
        'clang'
    ].filter(Boolean);

    for (const cmd of candidates) {
        if (/^[A-Za-z]:[\\/]/.test(cmd) || cmd.startsWith('/')) {
            if (!fs.existsSync(cmd)) continue;
        }
        try {
            const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
            if (!r.error && r.status === 0 && /gcc|clang|Free Software/i.test(String(r.stdout || ''))) {
                gccCommand = cmd;
                console.log(`[代码体检] 检测到 C 编译器: ${cmd}`);
                return cmd;
            }
        } catch (e) { /* 继续尝试下一个 */ }
    }
    gccCommand = null;
    console.log('[代码体检] 未检测到 gcc / clang，编译验证将关闭（静态扫描与 AI 诊断仍可用）');
    return null;
}

// ---------------------------------------------------------------
// 2. 子进程封装：超时、输出截断、Windows 进程树终止
// ---------------------------------------------------------------
function killTree(child) {
    if (!child || !child.pid) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
        } else {
            child.kill('SIGKILL');
        }
    } catch (e) { /* ignore */ }
}

function runProcess(command, args, opts = {}) {
    const { timeout = RUN_TIMEOUT, input = '', cwd, env } = opts;
    return new Promise((resolve) => {
        let stdout = '', stderr = '', timedOut = false, spawnError = null, done = false;
        let child;
        try {
            child = spawn(command, args, {
                cwd,
                windowsHide: true,
                env: env || process.env
            });
        } catch (e) {
            return resolve({ ok: false, code: -1, signal: null, stdout: '', stderr: String(e.message), timedOut: false });
        }

        const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);

        const finish = (code, signal) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({
                ok: code === 0 && !timedOut && !spawnError,
                code, signal: signal || null,
                stdout: stdout.slice(0, MAX_OUTPUT),
                stderr: stderr.slice(0, MAX_OUTPUT),
                timedOut,
                error: spawnError
            });
        };

        if (child.stdout) child.stdout.on('data', d => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8'); });
        if (child.stderr) child.stderr.on('data', d => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8'); });
        child.on('error', e => { spawnError = e.message; finish(-1, null); });
        child.on('close', (code, signal) => finish(code, signal));

        // 程序不读 stdin 时写入会触发 EPIPE，必须挂 error 监听，否则会拖垮整个服务
        if (child.stdin) child.stdin.on('error', () => { /* ignore */ });
        if (input) {
            try { child.stdin.write(input); } catch (e) { /* 程序提前退出 */ }
        }
        try { child.stdin.end(); } catch (e) { /* ignore */ }
    });
}

// ---------------------------------------------------------------
// 3. gcc 诊断解析 + 中文化（C 学习者最需要的一环）
// ---------------------------------------------------------------
const DIAG_RULES = [
    [/expected ['`\u2018\u2019]?;['`\u2018\u2019]?/i, '这一行末尾少了分号 ;', '检查上一行与本行结尾，C 语句必须以分号结束。'],
    [/expected declaration or statement at end of input/i, '大括号 } 没有配对，可能少写了一个 }', '从 main 开始逐个数 { 与 } 是否成对。'],
    [/expected ['`]?\)['`]?/i, '括号 ) 没有配对', '检查 printf / if / for 的括号是否闭合。'],
    [/expected expression before/i, '表达式写法不完整', '检查运算符两侧是否都有操作数，是否多写了逗号或分号。'],
    [/stray ['`]?\\/i, '代码里混入了中文全角符号', '把中文分号、引号、括号全部改成英文半角符号。'],
    [/undeclared \(first use in this function\)/i, '变量 / 函数没有声明就使用', '检查拼写，或补上 #include <stdio.h>、<string.h>、<stdlib.h> 等头文件。'],
    [/implicit declaration of function/i, '函数缺少对应的头文件声明', '例如 sqrt 需要 math.h，strlen 需要 string.h，malloc 需要 stdlib.h。'],
    [/invalid type argument of ['`]?->['`]?/i, '对非指针用了 ->', '结构体变量用 . 访问成员，结构体指针才用 ->。'],
    [/assignment makes pointer from integer/i, '把整数赋给了指针', '多半是 scanf 漏写 &，或者指针与值混用。'],
    [/format .* expects argument of type/i, 'printf / scanf 的格式符与参数类型不匹配', '%d 对应 int，%f 对应 double（printf），%lf 对应 double*（scanf）。'],
    [/too few arguments for format|too many arguments for format/i, '格式符个数与后面给的参数个数不一致', '逐个对照 % 占位符与逗号后的参数。'],
    [/comparison between pointer and integer/i, '指针和整数在做比较', '多半是漏写了 * 解引用，或把数组名当成了元素值。'],
    [/suggest parentheses around assignment used as truth value/i, '条件里用了赋值号 =', '判断相等应写 ==，= 是赋值且恒为真/假。'],
    [/control reaches end of non-void function/i, '函数声明了返回值，但有分支没有 return', '补上兜底 return，或把返回类型改成 void。'],
    [/conflicting types for/i, '函数定义与前面的声明不一致', '检查函数原型、参数类型与返回值类型是否一致。'],
    [/lvalue required as left operand of assignment/i, '赋值号左边不是可修改的变量', '常见原因：把 == 写成了 =，或对常量/表达式赋值。'],
    [/subscripted value is not an array/i, '对非数组、非指针使用了下标 []', '检查变量名是否写错，或该变量是否应为数组。'],
    [/undefined reference to ['`]?main['`]?/i, '缺少 main 函数', 'C 程序必须有一个 int main(void) 作为入口。'],
    [/initializer element is not constant/i, '全局变量不能用非常量初始化', '把赋值移到 main 或函数内部。'],
    [/unused variable/i, '变量声明后没有使用', '不是错误，但可以删掉保持整洁。'],
    [/may be used uninitialized/i, '变量可能在未初始化时被使用', '声明时给初值，例如 int sum = 0;'],
    [/unrecognized command-line option|unknown argument|unsupported option|cannot find -lasan/i, '编译器不支持该编译选项', '系统会自动去掉该选项重试。']
];

function translateDiag(raw) {
    for (const [re, zh, hint] of DIAG_RULES) {
        if (re.test(raw)) return { zh, hint };
    }
    return { zh: raw, hint: '结合报错行号检查语法与类型。' };
}

function parseDiagnostics(text) {
    const items = [];
    const seen = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = line.match(/:(\d+):(\d+):\s*(error|warning|note):\s*(.*)$/i);
        if (!m) continue;
        const type = m[3].toLowerCase();
        if (type === 'note') continue;
        const raw = m[4].trim();
        const key = m[1] + '|' + type + '|' + raw;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = translateDiag(raw);
        items.push({ line: Number(m[1]), col: Number(m[2]), type, raw, zh: t.zh, hint: t.hint });
    }
    return items;
}

// ---------------------------------------------------------------
// 4. Sanitizer 报告解析（C 独有：内存错误 / 未定义行为）
// ---------------------------------------------------------------
const ASAN_MAP = [
    [/stack-buffer-overflow/i, '栈上数组越界', '访问了数组合法范围之外的元素，检查下标是否等于或超过数组长度。'],
    [/heap-buffer-overflow/i, '堆内存越界', 'malloc 申请的空间不够，检查申请长度与循环上界。'],
    [/use-after-free/i, '使用了已经 free 的内存', 'free 之后不要再读写该指针，可把指针置为 NULL。'],
    [/double-free/i, '同一块内存被释放了两次', '检查 free 是否被执行了多遍。'],
    [/stack-use-after-return|stack-use-after-scope/i, '使用了已失效的局部变量地址', '不要返回局部变量的地址，需要长期存在请用 malloc。'],
    [/SEGV|segmentation fault/i, '非法内存访问（空指针 / 野指针）', '检查指针是否初始化、是否越界、scanf 是否漏写 &。'],
    [/memory leaks|LeakSanitizer/i, '内存泄漏', 'malloc / calloc 申请的空间要用 free 归还。']
];
const UBSAN_MAP = [
    [/signed integer overflow/i, '有符号整数溢出（未定义行为）', '换用更大的类型 long long，或在运算前做范围判断。'],
    [/division by zero/i, '除以零', '做除法前判断除数是否为 0。'],
    [/shift exponent/i, '移位位数非法', '移位位数必须小于类型位宽且不能为负。'],
    [/null pointer passed as argument/i, '把空指针传给了函数', '调用前检查指针是否为 NULL。'],
    [/load of misaligned address|misaligned address/i, '未对齐的内存访问', '避免把 char* 强转成 int* 之类的跨类型指针转换。'],
    [/array index .* out of bounds/i, '数组下标越界', '检查循环终止条件是否写成 <= 数组长度。'],
    [/load of value .* which is not a valid value for type/i, '读取了未初始化 / 非法的值', '给变量赋初值，检查枚举或 bool 的取值来源。']
];

function parseSanitizer(text) {
    const s = String(text || '');
    const findings = [];
    const push = (kind, title, category, why, suggestion) => {
        if (!findings.some(f => f.title === title)) findings.push({ kind, title, category, why, suggestion, severity: 'high' });
    };
    if (/AddressSanitizer|LeakSanitizer/.test(s)) {
        const m = s.match(/ERROR: AddressSanitizer:\s*([^\n]+)/);
        const tag = m ? m[1] : (/LeakSanitizer/.test(s) ? 'memory leaks' : '内存访问异常');
        const hit = ASAN_MAP.find(([re]) => re.test(tag)) || ASAN_MAP.find(([re]) => re.test(s));
        if (hit) push('memory', hit[1], '指针与内存', hit[2], hit[3]);
        else push('memory', 'AddressSanitizer 捕获到内存错误', '指针与内存', tag, '按报告中的调用栈定位到对应源码行。');
    }
    const ubLines = s.split(/\r?\n/).filter(l => /runtime error:/.test(l));
    for (const l of ubLines.slice(0, 4)) {
        const hit = UBSAN_MAP.find(([re]) => re.test(l));
        if (hit) push('ub', hit[1], '未定义行为', hit[2], hit[3]);
        else {
            const msg = l.replace(/^.*runtime error:\s*/, '').trim();
            push('ub', '未定义行为：' + msg.slice(0, 60), '未定义行为', '编译器在运行时检测到 C 标准未定义的操作。', '对照该行表达式检查操作数范围与类型。');
        }
    }
    return findings;
}

// ---------------------------------------------------------------
// 5. 静态风险扫描：把字符串 / 注释掩掉，只留代码骨架，降低误报
// ---------------------------------------------------------------
function maskCode(code) {
    let out = '';
    let inBlock = false, inStr = false, inChar = false, esc = false;
    for (let i = 0; i < code.length; i++) {
        const c = code[i], n = code[i + 1];
        if (inBlock) {
            if (c === '*' && n === '/') { inBlock = false; out += '  '; i++; }
            else out += c === '\n' ? '\n' : ' ';
            continue;
        }
        if (inStr || inChar) {
            if (esc) { esc = false; out += ' '; continue; }
            if (c === '\\') { esc = true; out += ' '; continue; }
            if ((inStr && c === '"') || (inChar && c === "'")) { inStr = false; inChar = false; out += ' '; continue; }
            out += c === '\n' ? '\n' : ' ';
            continue;
        }
        if (c === '/' && n === '*') { inBlock = true; out += '  '; i++; continue; }
        if (c === '/' && n === '/') {
            while (i < code.length && code[i] !== '\n') { out += ' '; i++; }
            if (code[i] === '\n') out += '\n';
            continue;
        }
        if (c === '"') { inStr = true; out += ' '; continue; }
        if (c === "'") { inChar = true; out += ' '; continue; }
        out += c;
    }
    return out;
}

function lineAt(text, index) { return text.slice(0, index).split('\n').length; }

function staticScan(code) {
    const issues = [];
    const masked = maskCode(code);
    const lines = String(code).split('\n');
    const add = (line, severity, category, title, why, suggestion) => {
        issues.push({ line: Math.max(1, line), severity, category, title, why, suggestion, source: 'static' });
    };
    const seen = new Set();
    const once = (key, fn) => { if (!seen.has(key)) { seen.add(key); fn(); } };

    // ① 中文全角符号（编译失败头号原因，看原文）
    lines.forEach((l, i) => {
        if (/[；，。（）｛｝［］＜＞＝！＂＇、；]/u.test(l)) {
            once('fullwidth', () => add(i + 1, 'high', '语法与编译', '代码中混入了中文全角符号',
                'C 编译器只接受英文半角标点，全角分号 / 括号 / 引号会直接导致编译失败。',
                '把 ；，（）＂ 换成 ; , ( ) "，注意输入法切换。'));
        }
    });

    // ② 危险 / 无边界函数
    for (const m of masked.matchAll(/\bgets\s*\(/g)) {
        once('gets', () => add(lineAt(masked, m.index), 'high', '输入输出', '使用了已被废弃的 gets()',
            'gets 不检查缓冲区长度，输入过长会直接越界写内存，是经典的缓冲区溢出漏洞。',
            '改用 fgets(buf, sizeof(buf), stdin)，并注意去掉末尾的换行符。'));
    }
    for (const m of masked.matchAll(/\b(strcpy|strcat|sprintf)\s*\(/g)) {
        once(m[1], () => add(lineAt(masked, m.index), 'medium', '字符串', `${m[1]}() 不检查目标缓冲区长度`,
            '若源字符串比目标数组长，会发生越界写，属于 C 特有内存风险。',
            `改用 ${m[1] === 'sprintf' ? 'snprintf' : m[1] === 'strcpy' ? 'strncpy / snprintf' : 'strncat'}，并预留结尾 \\0 的位置。`));
    }

    // ③ 条件里的赋值号 =
    for (const m of masked.matchAll(/\b(?:if|while)\s*\(([^)]*)\)/g)) {
        const cond = m[1].replace(/==|!=|<=|>=|\+=|-=|\*=|\/=/g, '');
        if (/[^!<>=]=(?!=)/.test(cond)) {
            once('assign' + m.index, () => add(lineAt(masked, m.index), 'high', '条件与运算符', '判断条件里疑似写成了赋值号 =',
                'C 中 a = b 是赋值且表达式有值，条件会按赋值结果判真假，几乎总是逻辑错误。',
                '把 = 改成 ==；也可以写成 常量 == 变量，写错时编译器会直接报错。'));
        }
    }

    // ④ 字符串用 == 比较
    for (const m of String(code).matchAll(/(?:\b\w+\s*==\s*"|"\s*==\s*\b\w+)/g)) {
        once('strcmp', () => add(lineAt(String(code), m.index), 'high', '字符串', '字符串用 == 比较',
            '== 比较的是两个 char* 的地址，而不是字符串内容，结果几乎永远不相等。',
            '改用 strcmp(a, b) == 0，需要头文件 <string.h>。'));
    }

    // ⑤ malloc / free 不配对
    const allocCount = (masked.match(/\b(?:malloc|calloc|realloc)\s*\(/g) || []).length;
    const freeCount = (masked.match(/\bfree\s*\(/g) || []).length;
    if (allocCount > freeCount) {
        const m = /\b(?:malloc|calloc|realloc)\s*\(/.exec(masked);
        add(lineAt(masked, m.index), 'medium', '指针与内存', `动态内存申请 ${allocCount} 次，只释放 ${freeCount} 次`,
            '未释放的堆内存会一直占用到程序结束，长期运行的程序会持续泄漏。',
            '在使用完毕的分支（包括提前 return 的分支）补上 free(ptr)，并把指针置 NULL。');
    }

    // ⑥ 数组确定越界：先抹掉声明，再找下标
    const decls = {};
    const scanText = masked.replace(/\b(?:int|char|float|double|long|short)\s+(\w+)\s*\[\s*(\d+)\s*\]/g, (whole, name, size) => {
        decls[name] = Number(size);
        return whole.replace(/[^\n]/g, ' ');
    });
    for (const m of scanText.matchAll(/\b(\w+)\s*\[\s*(\d+)\s*\]/g)) {
        const size = decls[m[1]];
        if (size && Number(m[2]) >= size) {
            once('oob' + m.index, () => add(lineAt(scanText, m.index), 'high', '数组越界',
                `${m[1]}[${m[2]}] 越界（数组长度只有 ${size}）`,
                `合法下标是 0 ~ ${size - 1}。C 不做边界检查，越界读写是未定义行为，可能悄悄改坏别的变量或直接段错误。`,
                `把循环条件从 <= ${size} 改成 < ${size}，并检查下标计算式。`));
        }
    }

    // ⑥b 循环边界：for(...; i <= N; ...) 且存在长度为 N 的数组用 i 做下标
    // C 初学者最经典的越界写法：int a[5] 却写 i <= 5，会访问 a[5]
    for (const m of scanText.matchAll(/for\s*\([^;]*;\s*([A-Za-z_]\w*)\s*<=\s*(\d+)\s*;/g)) {
        const varName = m[1], bound = Number(m[2]);
        const arrName = Object.keys(decls).find(n => decls[n] === bound);
        if (!arrName) continue;
        if (new RegExp('\\b' + arrName + '\\s*\\[\\s*' + varName + '\\s*\\]').test(scanText)) {
            once('loopbound' + m.index, () => add(lineAt(scanText, m.index), 'high', '数组越界',
                `循环条件 ${varName} <= ${bound} 会让 ${arrName}[${varName}] 越界`,
                `${arrName} 的合法下标是 0 ~ ${bound - 1}，但循环最后一次会访问 ${arrName}[${bound}]。C 不检查数组边界，这属于未定义行为。`,
                `把 <= ${bound} 改成 < ${bound}（或 <= ${bound - 1}），让循环最多走到下标 ${bound - 1}。`));
        }
    }

    // ⑦ scanf 漏写 &（基于「普通标量变量」集合，避免把数组名误报）
    const scalars = new Set();
    for (const m of masked.matchAll(/\b(?:int|float|double|char)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;/g)) scalars.add(m[1]);
    // 只取 scanf 自己那一对括号，不能跨语句（否则会把后面 printf 的参数误判成 scanf 参数）
    for (const sm of masked.matchAll(/\bscanf\s*\(([^()]*)\)/g)) {
        const body = sm[1];
        for (const p of body.matchAll(/(?:^|,)\s*(&)?\s*([A-Za-z_]\w*)/g)) {
            if (!p[1] && scalars.has(p[2]) && p[2] !== 'scanf') {
                const abs = sm.index + 1 + (p.index || 0);
                once('scanf' + p[2], () => add(lineAt(masked, abs), 'high', '输入输出',
                    `scanf 读取 ${p[2]} 时疑似漏写 &`,
                    'scanf 需要变量的地址才能写入；传值会让函数把该值当地址，通常直接触发段错误。',
                    `写成 scanf("%d", &${p[2]})；数组名本身是地址，不需要 &。`));
                break;
            }
        }
    }

    // ⑧ 循环体是空语句
    for (const m of masked.matchAll(/\b(?:for|while)\s*\([^)]*\)\s*;/g)) {
        once('emptyloop' + m.index, () => add(lineAt(masked, m.index), 'high', '条件与运算符', '循环 / 判断后面直接跟了分号',
            '这个分号就是循环体（空语句），后面的代码块只会执行一次，是 C 初学者最隐蔽的坑之一。',
            '删掉这个分号，或用 { } 明确包住循环体。'));
    }

    // ⑨ 浮点用 == 比较
    const floats = new Set();
    for (const m of masked.matchAll(/\b(?:float|double)\s+([A-Za-z_]\w*)/g)) floats.add(m[1]);
    for (const name of floats) {
        const re = new RegExp('\\b' + name + '\\s*==', 'g');
        const m = re.exec(masked);
        if (m) {
            once('float' + name, () => add(lineAt(masked, m.index), 'low', '条件与运算符', `浮点数 ${name} 用 == 判等`,
                '浮点运算有精度误差，0.1+0.2 未必精确等于 0.3。',
                '改用 fabs(a - b) < 1e-6 之类的容差比较，需要 <math.h>。'));
        }
    }

    // ⑩ 声明未赋初值且全文没有赋值
    for (const m of masked.matchAll(/\b(?:int|float|double|char|long)\s+([A-Za-z_]\w*)\s*;/g)) {
        const name = m[1];
        const assignRe = new RegExp('\\b' + name + '\\s*(?:=|\\+=|-=|\\+\\+|--)', 'g');
        if (!assignRe.test(masked) && (masked.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length > 1) {
            once('uninit' + name, () => add(lineAt(masked, m.index), 'medium', '未定义行为', `变量 ${name} 未初始化就被使用`,
                '局部变量未赋初值时内容是随机的，读取它属于未定义行为，结果每次运行都可能不同。',
                `声明时给初值，例如 int ${name} = 0;。`));
        }
    }

    // ⑪ sizeof 用在指针形参上
    const ptrParams = new Set();
    for (const m of masked.matchAll(/\b\w+\s*\*\s*([A-Za-z_]\w*)\s*[,)]/g)) ptrParams.add(m[1]);
    for (const name of ptrParams) {
        const m = new RegExp('\\bsizeof\\s*\\(\\s*' + name + '\\s*\\)').exec(masked);
        if (m) {
            once('sizeofptr' + name, () => add(lineAt(masked, m.index), 'medium', '指针与内存', `sizeof(${name}) 得到的是指针大小`,
                '数组作为函数参数会退化为指针，sizeof 返回 8（或 4）而不是数组字节数。',
                '把数组长度作为单独参数传进函数，或在定义数组的作用域内求 sizeof。'));
        }
    }

    // ⑬ free 之后继续读写（use-after-free，无编译器时也能抓到）
    for (const m of masked.matchAll(/\bfree\s*\(\s*([A-Za-z_]\w*)\s*\)\s*;/g)) {
        const name = m[1];
        const after = masked.slice(m.index + m[0].length);
        const use = new RegExp('\\b' + name + '\\s*\\[|\\*\\s*' + name + '\\b|\\b' + name + '\\s*->').exec(after);
        if (use) {
            once('uaf' + name, () => add(lineAt(masked, m.index + m[0].length + use.index), 'high', '指针与内存',
                `free(${name}) 之后又访问了这块内存`,
                'free 只把内存归还给系统，指针本身仍指向原地址；继续读写就是 use-after-free，属于未定义行为，可能读到垃圾值或直接崩溃。',
                `把访问移到 free 之前；或 free 后立即写 ${name} = NULL;，并在每次使用前判空。`));
        }
    }

    // ⑭ 缺 main
    if (!/\bmain\s*\(/.test(masked)) {
        add(1, 'high', '语法与编译', '没有找到 main 函数',
            'C 程序必须有 main 作为入口，否则链接阶段会报 undefined reference to main。',
            '补上 int main(void) { ... return 0; }。');
    }

    const rank = { high: 0, medium: 1, low: 2 };
    return issues.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (a.line - b.line));
}

// ---------------------------------------------------------------
// 6. 编译 + 运行
// ---------------------------------------------------------------
async function compileAndRun(dir, code, { stdin, sanitizer }) {
    fs.mkdirSync(dir, { recursive: true });   // sanitizer 用的是另一个临时目录
    const src = path.join(dir, 'main.c');
    fs.writeFileSync(src, code, 'utf8');
    const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main.out');
    const base = ['-std=c11', '-Wall', '-Wextra', '-O0', '-fdiagnostics-color=never', '-fno-diagnostics-show-caret'];
    const charset = ['-finput-charset=UTF-8', '-fexec-charset=UTF-8'];
    const san = sanitizer ? ['-fsanitize=address,undefined', '-g', '-fno-omit-frame-pointer'] : [];
    const cmd = detectGcc();

    const build = async (flags) => {
        const t0 = Date.now();
        const r = await runProcess(cmd, [...flags, src, '-o', exe], { timeout: COMPILE_TIMEOUT, cwd: dir });
        return { ...r, ms: Date.now() - t0 };
    };

    let r = await build([...base, ...charset, ...san]);
    // clang 等编译器不支持 -fexec-charset，去掉后重试一次
    if (!r.ok && /unrecognized|unknown argument|unsupported option|invalid argument/i.test(r.stderr)) {
        r = await build([...base, ...san]);
    }

    if (san && !r.ok && /cannot find -lasan|unrecognized|unknown argument|unsupported option|undefined reference.*asan|library not found for -lasan/i.test(r.stderr)) {
        sanitizerSupported = false;
        return { compile: { ok: false, skipped: true, reason: '当前编译器不支持 AddressSanitizer / UBSan', raw: r.stderr, ms: r.ms }, run: null };
    }

    const allDiag = parseDiagnostics(r.stderr);
    const compile = {
        ok: r.ok,
        errors: allDiag.filter(d => d.type === 'error'),
        warnings: allDiag.filter(d => d.type === 'warning'),
        raw: r.stderr.slice(0, 3000),
        timedOut: r.timedOut,
        ms: r.ms
    };
    if (!r.ok) return { compile, run: null };

    const env = {
        ...process.env,
        ASAN_OPTIONS: 'detect_leaks=1:halt_on_error=0:print_summary=1',
        UBSAN_OPTIONS: 'print_stacktrace=0:halt_on_error=0'
    };
    const t1 = Date.now();
    const rr = await runProcess(exe, [], { timeout: RUN_TIMEOUT, input: stdin || '', cwd: dir, env });
    const crashed = !!rr.timedOut || (rr.code !== 0 && rr.code !== null) || /Segmentation fault|SIGSEGV|AddressSanitizer|runtime error:/i.test(rr.stderr);
    return {
        compile,
        run: {
            executed: true,
            stdout: rr.stdout,
            stderr: rr.stderr,
            exitCode: rr.code,
            signal: rr.signal,
            timedOut: rr.timedOut,
            crashed,
            ms: Date.now() - t1
        }
    };
}

function normalizeOut(s) {
    return String(s == null ? '' : s).replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
}

// ---------------------------------------------------------------
// 7. 主分析流程：四层证据 → 评分 → AI 教练
// ---------------------------------------------------------------
async function analyze(params) {
    const {
        code, stdin = '', taskGoal = '', expectedStdout = '',
        useAI = true, useSanitizer = true
    } = params;

    const cmd = detectGcc();
    const staticIssues = staticScan(code);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-review-'));

    let compile = { ok: false, skipped: true, reason: cmd ? '' : '未检测到 gcc / clang，编译与运行验证未启用', errors: [], warnings: [], raw: '', ms: 0 };
    let run = null;
    let sanitizer = { enabled: false, supported: !!cmd, findings: [], raw: '', note: cmd ? '' : '需要本机 C 编译器' };

    try {
        if (cmd) {
            const normal = await compileAndRun(dir, code, { stdin, sanitizer: false });
            compile = normal.compile;
            run = normal.run;

            const wantSan = useSanitizer && sanitizerSupported !== false && compile.ok;
            if (wantSan) {
                const sanResult = await compileAndRun(dir + '-san', code, { stdin, sanitizer: true });
                // compileAndRun 会自己建目录，需要提前创建
                if (sanResult.compile.skipped) {
                    sanitizer = { enabled: false, supported: false, findings: [], raw: '', note: sanResult.compile.reason };
                } else {
                    const sanText = (sanResult.compile.raw || '') + '\n' + (sanResult.run ? sanResult.run.stderr : '');
                    sanitizer = {
                        enabled: true,
                        supported: true,
                        findings: parseSanitizer(sanText),
                        raw: sanText.slice(0, 3000),
                        note: ''
                    };
                    if (sanitizer.findings.length === 0 && sanResult.run && sanResult.run.crashed && !(run && run.crashed)) {
                        sanitizer.findings.push({
                            kind: 'memory', title: '内存检测模式下程序崩溃', category: '指针与内存', severity: 'high',
                            why: '普通模式能通过、Instrumentation 模式崩溃，通常意味着存在越界写或使用了失效地址。',
                            suggestion: '重点检查数组下标、指针运算与 malloc 的空间长度。'
                        });
                    }
                    sanitizerSupported = true;
                }
            } else if (sanitizerSupported === false) {
                sanitizer.note = '当前编译器不支持 Sanitizer，已由静态风险规则补位';
            }
        }
    } finally {
        // 清理临时目录（Windows 上 exe 可能仍被占用，删不掉可忽略）
        for (const d of [dir, dir + '-san']) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
    }

    // 测试用比对
    const test = { enabled: !!String(expectedStdout).trim(), passed: null, expected: expectedStdout, actual: run ? run.stdout : '', reason: '' };
    if (test.enabled) {
        if (!run || !run.executed) test.reason = '程序未能运行，无法比对输出';
        else {
            test.passed = normalizeOut(test.actual) === normalizeOut(test.expected);
            test.reason = test.passed ? '输出与期望完全一致' : '实际输出与期望不一致，检查算法逻辑、循环边界与输出格式（空格/换行）';
        }
    }

    // 客观评分（可复现，不依赖模型心情）
    let score = 100;
    score -= Math.min(60, compile.errors.length * 18);
    score -= Math.min(24, compile.warnings.length * 6);
    if (run && run.crashed) score -= 25;
    score -= Math.min(40, sanitizer.findings.length * 20);
    score -= Math.min(30, staticIssues.reduce((s, i) => s + (i.severity === 'high' ? 12 : i.severity === 'medium' ? 6 : 2), 0));
    if (test.enabled && test.passed === false) score -= 20;
    score = Math.max(0, Math.min(100, Math.round(score)));

    let verdict;
    if (!cmd) verdict = '静态体检完成 · 未启用编译验证';
    else if (!compile.ok && compile.errors.length) verdict = '编译未通过 · 先修语法';
    else if (run && run.crashed) verdict = '运行崩溃 · 定位内存 / 越界';
    else if (sanitizer.findings.length) verdict = '存在内存或 undefined behavior 风险';
    else if (test.enabled && test.passed === false) verdict = '输出与预期不符 · 逻辑需修正';
    else if (staticIssues.some(i => i.severity === 'high')) verdict = '可以运行，但写法有高风险';
    else if (score >= 85) verdict = '通过 · 代码质量良好';
    else verdict = '基本可用 · 建议按提示优化';

    const categories = [...new Set([
        ...compile.errors.map(() => '语法与编译'),
        ...compile.warnings.map(() => '编译警告'),
        ...sanitizer.findings.map(f => f.category),
        ...staticIssues.map(i => i.category)
    ])];

    const evidence = {
        env: { gcc: !!cmd, compiler: cmd || null, sanitizer: sanitizer.enabled },
        compile, run, sanitizer, test,
        static: { issues: staticIssues },
        score, verdict, categories,
        taskGoal,
        checkedAt: new Date().toISOString()
    };

    // AI 教练刻意不在这里等：客观证据先返回，前端再异步请求 /api/code/coach 补充结论。
    // 这样本地小模型加载 20~40 秒也不会白屏，Ollama 没启动也不影响体检报告本身。
    const aiNote = useAI ? '' : '已关闭 AI 诊断，仅展示编译 / 运行 / 静态扫描的客观结果';
    return { ok: true, evidence, ai: null, aiNote, coachPending: !!useAI };
}

// ---------------------------------------------------------------
// 8. AI 教练：只解释证据 + 给最小提示，禁止直接给完整答案
// ---------------------------------------------------------------
const TUTOR_SYSTEM = `你是一位严格的 C 语言实训教练，面向初学 C 语言的大学生。

你的输入是一份【客观体检证据】：gcc 编译诊断、真实运行结果、AddressSanitizer/UBSan 报告、静态风险规则和测试用例比对结果。
请严格遵守：
1. 只依据给定证据下结论，不要臆测证据里没有出现的 bug，也不要重复罗列证据原文。
2. 用中文，语气像教练：先说结论，再指出最该先改的 1~3 个问题，最后给可执行的下一步。
3. 【最重要】绝对不要写出完整的正确代码，也不要给出可直接粘贴的完整修复版；只给「改哪一行的哪个符号 / 检查哪个条件」这种最小提示，把动手改代码留给学生。
4. 按知识点归类问题（如：数组越界、指针与内存、输入输出、条件与运算符、字符串、未定义行为、语法与编译）。
5. 若证据显示程序已正确，指出代码中值得肯定的写法，并给一个进阶改进方向。
6. 只输出一个合法 JSON 对象，不要 Markdown 代码块，不要任何解释文字。
JSON 结构：
{"summary":"一句话总评","priority":["最该先做的事1","最该先做的事2"],"issues":[{"line":0,"category":"知识点","severity":"high|medium|low","why":"为什么错（结合 C 语言机制）","suggestion":"具体修改建议","fixHint":"一行最小提示，不含完整代码"}],"strengths":["做得好的地方"],"nextSteps":["下一步练习建议"],"knowledgePoints":["涉及知识点"]}`;

function buildEvidenceBrief(code, ev) {
    const numbered = String(code).split('\n').slice(0, 120)
        .map((l, i) => `${String(i + 1).padStart(3, ' ')}| ${l.slice(0, 160)}`).join('\n');
    const brief = [
        `【任务目标】${ev.taskGoal || '（学生未填写，请只针对代码本身判断）'}`,
        `【编译器】${ev.env.compiler || '未检测到'}  【Sanitizer】${ev.env.sanitizer ? '已启用' : '未启用/不支持'}`,
        `【客观评分】${ev.score}/100  【结论】${ev.verdict}`,
        `【编译】${ev.compile.ok ? '通过' : '未通过/跳过'}${ev.compile.reason ? ' · ' + ev.compile.reason : ''}`,
        ...ev.compile.errors.slice(0, 8).map(d => `  第${d.line}行 error: ${d.zh}`),
        ...ev.compile.warnings.slice(0, 8).map(d => `  第${d.line}行 warning: ${d.zh}`),
        `【运行】${ev.run && ev.run.executed ? `退出码 ${ev.run.exitCode}${ev.run.crashed ? ' · 崩溃/超时' : ''}` : '未执行'}`,
        ev.run && ev.run.executed ? `  stdout: ${String(ev.run.stdout).slice(0, 400) || '（空）'}` : '',
        ev.run && ev.run.stderr ? `  stderr: ${String(ev.run.stderr).slice(0, 500)}` : '',
        `【内存/未定义行为检测】${ev.sanitizer.findings.length ? ev.sanitizer.findings.map(f => f.title + '：' + f.why).join('；') : '未发现问题或未启用'}`,
        `【静态风险扫描】${ev.static.issues.length ? ev.static.issues.slice(0, 10).map(i => `第${i.line}行 [${i.severity}] ${i.title}`).join('；') : '未发现'}`,
        `【测试用例】${ev.test.enabled ? (ev.test.passed ? '通过' : '未通过 · ' + ev.test.reason) : '未提供期望输出'}`,
        '', '【学生代码（带行号）】', numbered
    ].filter(Boolean).join('\n');
    return brief.slice(0, 6500);
}

function stripThink(s) {
    let t = String(s || '');
    t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
    const i = t.indexOf('<think>');
    if (i !== -1) t = t.slice(0, i);
    return t.trim();
}

async function aiDiagnose(code, ev) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT);
    try {
        const resp = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: [
                    { role: 'system', content: TUTOR_SYSTEM },
                    { role: 'user', content: buildEvidenceBrief(code, ev) }
                ],
                stream: false,
                think: false,
                format: 'json',
                options: { temperature: 0, num_predict: 600 },
                keep_alive: '30m'
            })
        });
        if (!resp.ok) throw new Error('Ollama HTTP ' + resp.status);
        const data = await resp.json();
        const raw = stripThink(data.message && data.message.content);
        if (!raw) throw new Error('模型返回为空');
        let parsed = null;
        try { parsed = JSON.parse(raw); }
        catch (e) {
            const s = raw.indexOf('{'), t = raw.lastIndexOf('}');
            if (s !== -1 && t > s) parsed = JSON.parse(raw.slice(s, t + 1));
        }
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            summary: String(parsed.summary || ''),
            priority: Array.isArray(parsed.priority) ? parsed.priority.slice(0, 4) : [],
            issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 10) : [],
            strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 5) : [],
            nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.slice(0, 5) : [],
            knowledgePoints: Array.isArray(parsed.knowledgePoints) ? parsed.knowledgePoints.slice(0, 8) : []
        };
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('AI 诊断超时');
        throw new Error(e.message || 'Ollama 未启动');
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------
// 9. 路由注册：只需在 server-ollama.js 里调用一次
// ---------------------------------------------------------------
function registerRoutes(app) {
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 200 * 1024 }
    });

    // 上传自己的 .c / .cpp / .txt 源码文件
    app.post('/api/code/upload', upload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: '未收到文件' });
        const ext = path.extname(req.file.originalname || '').toLowerCase();
        if (ext && !['.c', '.h', '.cpp', '.cc', '.txt', '.md'].includes(ext)) {
            return res.status(400).json({ error: '仅支持 .c / .h / .cpp / .txt / .md 源码文件' });
        }
        // multer 在部分环境下会把中文文件名按 latin1 解码，这里还原
        let filename = req.file.originalname || 'mycode.c';
        try { filename = Buffer.from(filename, 'latin1').toString('utf8'); } catch (e) { /* ignore */ }
        const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
        if (!text.trim()) return res.status(400).json({ error: '文件内容为空' });
        res.json({ filename, code: text.slice(0, MAX_CODE), size: req.file.size, truncated: text.length > MAX_CODE });
    });

    // 环境自检：前端右上角三盏灯
    app.get('/api/code/env', async (req, res) => {
        let ollama = false;
        try {
            const c = new AbortController();
            const t = setTimeout(() => c.abort(), 1500);
            const r = await fetch('http://localhost:11434/api/tags', { signal: c.signal });
            clearTimeout(t);
            ollama = r.ok;
        } catch (e) { /* 未启动 */ }
        const compiler = detectGcc();
        res.json({ gcc: !!compiler, compiler, sanitizer: !!compiler && sanitizerSupported !== false, ollama });
    });

    // AI 教练（第二步、异步）：前端拿到客观报告后再来取，避免模型慢拖住主流程
    app.post('/api/code/coach', async (req, res) => {
        const { code, evidence } = req.body || {};
        if (!code || !evidence || typeof evidence !== 'object') {
            return res.status(400).json({ ok: false, error: '缺少代码或体检证据' });
        }
        try {
            const ai = await aiDiagnose(String(code).slice(0, MAX_CODE), evidence);
            if (!ai) return res.json({ ok: false, error: 'AI 教练未返回有效结论' });
            res.json({ ok: true, ai });
        } catch (e) {
            res.json({ ok: false, error: e.message || 'AI 教练暂不可用' });
        }
    });

    // 主体检接口
    app.post('/api/code/analyze', async (req, res) => {
        if (activeJobs >= MAX_CONCURRENCY) {
            return res.status(429).json({ error: '当前体检任务较多，请稍后再试' });
        }
        const body = req.body || {};
        const code = typeof body.code === 'string' ? body.code.replace(/^\uFEFF/, '') : '';
        if (!code.trim()) return res.status(400).json({ error: '代码内容为空，请先上传或粘贴 C 代码' });
        if (code.length > MAX_CODE) return res.status(413).json({ error: `代码过长，上限 ${MAX_CODE} 字符` });

        activeJobs++;
        const t0 = Date.now();
        try {
            const result = await analyze({
                code,
                stdin: String(body.stdin || '').slice(0, 2000),
                taskGoal: String(body.taskGoal || '').slice(0, 500),
                expectedStdout: String(body.expectedStdout || '').slice(0, 2000),
                useAI: body.useAI !== false,
                useSanitizer: body.useSanitizer !== false
            });
            console.log(`[代码体检] 完成 评分=${result.evidence.score} 结论=${result.evidence.verdict} 耗时=${Date.now() - t0}ms`);
            res.json(result);
        } catch (e) {
            console.error('[代码体检] 失败:', e);
            res.status(500).json({ error: '体检失败：' + (e.message || '未知错误') });
        } finally {
            activeJobs--;
        }
    });
}

module.exports = { registerRoutes, analyze, detectGcc, staticScan, parseDiagnostics };
