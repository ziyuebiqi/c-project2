// 最顶部加这一行，兼容 pdf-parse v2 在 Node 环境的依赖
require('pdf-parse/worker'); 

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const kb = require('./kb');
const codeReview = require('./codeReview');   // C 代码体检引擎（独立模块，不影响原有接口）

const app = express();
const port = 3001; 

app.use(cors());
app.use(express.json());

// ===== 文件上传配置 =====
const upload = multer({ dest: path.join(__dirname, 'uploads_tmp') });
// 知识库上传走内存，直接拿 buffer 交给解析器，不落临时文件
const kbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: kb.MAX_FILE_SIZE } });
const tmpDir = path.join(__dirname, 'uploads_tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

// 用 127.0.0.1 而不是 localhost：Ollama 默认只监听 IPv4，部分 Node 版本会把 localhost 解析成 ::1 导致 ECONNREFUSED
const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_TAGS = 'http://127.0.0.1:11434/api/tags';
// 确认此处是你现在测试的模型名称
const OLLAMA_MODEL = 'qwen3:4b'; //换成8b的pdf会对接错误

// ================= PDF 解析接口 =================
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '未收到 PDF 文件' });
    const filePath = req.file.path;
    
    try {
        const buffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        await parser.destroy(); 
        
        const text = (result.text || '').trim();
        if (!text) return res.status(400).json({ error: 'PDF 中未提取到文本' });
        
        const MAX_LEN = 12000;
        const trimmed = text.length > MAX_LEN ? text.slice(0, MAX_LEN) + '\n...(内容过长已截断)' : text;
        res.json({ text: trimmed });
    } catch (err) {
        console.error('PDF 解析失败:', err);
        res.status(500).json({ error: 'PDF 解析失败：' + err.message });
    } finally {
        fs.unlink(filePath, () => {});
    }
});

// ================= 自有课件知识库接口 =================

// 上传课件：解析 -> 分块 -> 持久化
app.post('/api/kb/upload', kbUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    try {
        const text = await kb.parseFile(req.file);
        const doc = kb.addDocument(req.file, text);
        console.log(`[知识库] 已入库 ${doc.name}：${doc.charCount} 字，切为 ${doc.chunkCount} 块`);
        res.json({ ok: true, doc });
    } catch (err) {
        console.error('[知识库] 上传失败:', err);
        res.status(500).json({ error: err.message || '课件解析失败' });
    }
});

// 文档列表 + 统计
app.get('/api/kb/list', (req, res) => {
    try { res.json({ ok: true, ...kb.listDocuments() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// 删除文档（连同它的所有分块）
app.post('/api/kb/delete', (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: '缺少 id' });
    const ok = kb.deleteDocument(id);
    res.json({ ok, error: ok ? undefined : '未找到该文档' });
});

// 启用 / 停用文档
app.post('/api/kb/toggle', (req, res) => {
    const { id, enabled } = req.body || {};
    if (!id) return res.status(400).json({ error: '缺少 id' });
    const doc = kb.toggleDocument(id, enabled);
    res.json({ ok: !!doc, doc });
});

// 预览某份文档的分块
app.get('/api/kb/chunks', (req, res) => {
    res.json({ ok: true, chunks: kb.getChunks(req.query.id) });
});

// 检索测试（管理页用，也可用于以后换向量检索时对比效果）
app.post('/api/kb/search', (req, res) => {
    const { query, topK } = req.body || {};
    if (!query) return res.status(400).json({ error: '缺少 query' });
    res.json({ ok: true, results: kb.search(query, topK || 4) });
});

// ================= 聊天接口 =================

// 兜底清理 qwen3 思考内容：剔除完整的 <think>...</think> 块，
// 以及还没闭合的思考块（流式输出中途只出现 <think> 开头的情况）
function stripThink(s) {
    if (!s) return s;
    s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
    const openIdx = s.indexOf('<think>');
    if (openIdx !== -1) s = s.slice(0, openIdx);
    return s;
}

// 把「连不上 / 超时 / 模型没拉 / 连接被断开」分开说清楚，
// 避免所有异常都被笼统报成「请确认 Ollama 已启动」，掩盖真实原因。
function describeOllamaError(e) {
    const code = (e && (e.code || (e.cause && e.cause.code))) || '';
    const msg = String((e && e.message) || e || '');
    if (e && (e.name === 'TimeoutError' || /timeout/i.test(msg)))
        return '本地模型生成超时（题目太多或机器较慢），建议减少题量，或点「内置 C 真题秒练」';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ECONNREFUSED|fetch failed/i.test(msg))
        return '连不上本机 Ollama（127.0.0.1:11434）。请先启动 Ollama 桌面程序，或在终端执行 ollama serve';
    if (/aborted|abort/i.test(msg) && !/timeout/i.test(msg))
        return '本次生成已取消';
    if (/socket hang up|ECONNRESET|terminated|undici/i.test(msg))
        return '与 Ollama 的连接在生成途中被断开（模型可能被重启或内存不足），请减少题量后重试';
    return '本地模型调用失败：' + msg.slice(0, 160);
}

// 出卷前的前端自检：2 秒内判断「3001 服务 / Ollama / 模型」三层是否就绪，
// 不就绪就立刻秒开内置真题，不让学生白等一两分钟。
app.get('/api/ollama/status', async (req, res) => {
    try {
        const r = await fetch(OLLAMA_TAGS, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
        const j = await r.json();
        const models = (j.models || []).map(m => String(m.name || ''));
        const ready = models.some(n => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL + ':'));
        res.json({
            ok: true, ready, model: OLLAMA_MODEL, models,
            reason: ready ? '' : ('本机已启动 Ollama，但没有找到模型 ' + OLLAMA_MODEL + '，请执行 ollama pull ' + OLLAMA_MODEL)
        });
    } catch (e) {
        res.json({ ok: false, ready: false, model: OLLAMA_MODEL, models: [], reason: describeOllamaError(e) });
    }
});

app.post('/api/ollama', async (req, res) => {
    const { message, pdfText, stream, kbEnabled, task, history, quizCount } = req.body;

    if (!message) return res.status(400).json({ error: '请求参数缺失，请提供 message' });

    // 图谱抽取是「结构化数据转换」任务，不需要模型长篇推理。
    // 前端传 task:'graph' 时走专用参数：约束解码 + 关闭思考 + 限制输出长度，显著提速且保证 JSON 合法。
    const isGraphTask = task === 'graph';
    // 题库批改同样是结构化任务：只要一段判定 JSON，不需要思考过程
    const isGradeTask = task === 'grade';
    // 练习卷生成：前端需要可交互的结构化题目（题型 / 选项 / 答案 / 解析 / 可编译代码）
    const isQuizTask = task === 'quiz';
    const isStructuredTask = isGraphTask || isGradeTask || isQuizTask;

    // ================= 多轮上下文 =================
    // 前端把当前会话最近 6 轮（12 条）传过来，这里做白名单过滤后拼进 messages。
    // 结构化任务（图谱 / 批改）刻意忽略上下文，保持输入精简、输出稳定。
    const historyMsgs = (!isStructuredTask && Array.isArray(history))
        ? history
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .slice(-12)
            .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))
        : [];

    // 注意：不要在提示词里写"禁止输出思考过程"之类的指令——
    // 小模型会把自己的推理过程当成正文输出。正确做法是让模型正常思考，
    // 思考内容由 Ollama 放进独立的 message.thinking 字段，服务器只转发正文 content。
    let systemContent = pdfText
        ? `你是一个专业的C语言AI小助手，负责解答C语言问题、批改代码。下面是一份用户上传的PDF资料，请结合它回答问题：\n\n【PDF资料开始】\n${pdfText}\n【PDF资料结束】`
        : '你是一个专业的C语言AI小助手，负责解答C语言问题、批改代码。回答请简洁明了。';

    // 练习卷：覆盖通用 system，强制纯 JSON（前端靠它渲染成可作答的交互卡片）
    if (isQuizTask) {
        systemContent = '你是 C 语言实训题生成器。只输出一个合法 JSON 对象，不要 Markdown 代码块、不要任何解释文字。'
            + '所有题目必须紧扣 C 语言本身（编译、指针、内存、数组越界、未定义行为、预处理、结构体等），不要出成通用计算机常识题。'
            + '题目里给出的 C 代码必须能在 gcc -std=c11 下编译（改错题除外，改错题要故意含一个明确的错误）。'
            + '字符串值内部的换行一律写成 \\n，不要出现真实换行或未经转义的引号。';
        // 保留原有「结合上传的 PDF 出题」能力，只截取片段避免把结构化输出挤爆
        if (pdfText) {
            systemContent += '\n\n【参考课件（题目可优先贴合，但依然只输出 JSON）】\n' + String(pdfText).slice(0, 1200);
        }
    }

    // 自有课件知识库：只把检索到的最相关片段注入，不塞整份课件
    let kbHitCount = 0;
    if (kbEnabled) {
        try {
            const ctx = kb.buildContext(message);
            if (ctx.text) {
                kbHitCount = ctx.hits.length;
                systemContent += `\n\n下面是学生上传的课件资料中与本次问题最相关的片段。请优先依据这些资料回答，并在合适处说明依据来自哪份课件；若资料中没有相关内容，再用你自己的知识作答并说明这一点。\n\n【课件资料开始】\n${ctx.text}\n【课件资料结束】`;
            }
        } catch (e) {
            console.error('[知识库] 检索失败:', e.message);
        }
    }

    const ollamaBody = {
        model: OLLAMA_MODEL,
        messages: [
            { role: 'system', content: systemContent },
            ...historyMsgs,
            { role: 'user', content: message }
        ],
        stream: !!stream,
        think: isStructuredTask ? false : true,  // 普通问答显式开启思考（只转发正文 content）；结构化任务关闭思考以提速
        keep_alive: '30m'      // 提速：模型常驻显存/内存 30 分钟，避免每次请求都重新加载模型
    };

    if (isGraphTask) {
        ollamaBody.format = 'json';   // Ollama 约束解码，从根上杜绝「模型输出解释文字 / 思考过程导致解析失败」
        ollamaBody.options = { temperature: 0, num_predict: 2000 };
    }
    if (isGradeTask) {
        ollamaBody.format = 'json';
        ollamaBody.options = { temperature: 0, num_predict: 500 };
    }
    if (isQuizTask) {
        ollamaBody.format = 'json';   // 约束解码，保证前端拿到可解析的练习卷
        // 按题量给生成上限：以前固定 3200，3 题也要空跑好几万毫秒，
        // 本地小模型长时间无响应最容易被浏览器/代理判超时。
        const n = Math.max(1, Math.min(12, Number(quizCount) || 3));
        ollamaBody.options = { temperature: 0.3, num_predict: Math.min(3200, 700 + n * 420) };
    }

    // 客户端关页面 / 点「取消」时同步中止 Ollama 生成。
    // 否则残留的生成任务会一直占着模型队列，把之后的每一次出题都堵到超时。
    const ctrl = new AbortController();
    const timeoutMs = stream ? 15 * 60 * 1000 : 8 * 60 * 1000;
    const timer = setTimeout(() => {
        ctrl.abort(Object.assign(new Error('Ollama 生成超时'), { name: 'TimeoutError' }));
    }, timeoutMs);
    const onClientClose = () => { if (!res.writableEnded) ctrl.abort(); };
    res.on('close', onClientClose);

    try {
        console.log(`收到前端消息: ${message}${pdfText ? ' [附带PDF上下文]' : ''}${kbHitCount ? ` [课件命中${kbHitCount}段]` : ''}${stream ? ' [流式]' : ''}`);

        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaBody),
            signal: ctrl.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Ollama 返回错误:', response.status, errText);
            let detail = errText.replace(/\s+/g, ' ').slice(0, 200);
            if (/model.*not found/i.test(detail))
                detail = '本机没有拉取模型 ' + OLLAMA_MODEL + '，请在终端执行 ollama pull ' + OLLAMA_MODEL;
            return res.status(500).json({ error: 'Ollama 返回错误（HTTP ' + response.status + '）：' + detail, canFallback: true });
        }

        // 非流式：等全部生成完一次性返回 JSON（出题/图谱/总结报告等一次性任务使用）
        if (!stream) {
            const data = await response.json();
            const rawReply = data.message && data.message.content ? data.message.content : '（模型未返回内容）';
            return res.json({ reply: stripThink(rawReply) });
        }

        // 提速关键③：流式转发——模型边生成、服务器边推送，前端逐字显示，无需等待全部生成
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        // 思考内容过滤状态机：
        // acc    —— 累计收到的全部正文
        // emitted —— 已推送给前端的字符数（只增不减，保证顺序）
        let acc = '';
        let emitted = 0;

        const pushVisible = (final = false) => {
            const visible = stripThink(acc);
            // 流式过程中暂时扣住末尾 8 个字符，防止 <think> 标签被拆在两个分块里导致误发
            const safeLen = final ? visible.length : Math.max(0, visible.length - 8);
            if (safeLen > emitted) {
                res.write(visible.slice(emitted, safeLen));
                emitted = safeLen;
            }
        };

        const processLine = (line) => {
            if (!line.trim()) return;
            try {
                const j = JSON.parse(line);
                // 只取正文 content；Ollama 的思考字段 message.thinking 在这里直接忽略
                if (j.message && j.message.content) acc += j.message.content;
                pushVisible();
            } catch (e) { /* 半行 JSON，忽略 */ }
        };

        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                processLine(buffer.slice(0, idx));
                buffer = buffer.slice(idx + 1);
            }
        }
        if (buffer.trim()) processLine(buffer);
        pushVisible(true); // 流结束，补发扣住的末尾内容
        res.end();

    } catch (error) {
        // 客户端主动取消（点「不等了」/ 关页面）属于正常操作，不打印成故障日志
        const clientGone = ctrl.signal.aborted && error && error.name === 'AbortError';
        if (!clientGone) console.error('调用 Ollama 出错:', error);
        if (!res.headersSent && !clientGone) {
            res.status(500).json({ error: describeOllamaError(error), canFallback: true });
        } else {
            try { res.end(); } catch (e) {}
        }
    } finally {
        clearTimeout(timer);
        res.off('close', onClientClose);
    }
});

// ===== C 代码体检模块（新增路由 /api/code/*，与上面的接口互不干扰） =====
codeReview.registerRoutes(app);

app.listen(port, () => {
    console.log(`Ollama 后端服务已启动: http://localhost:${port}`);
});