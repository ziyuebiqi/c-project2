// 最顶部加这一行，兼容 pdf-parse v2 在 Node 环境的依赖
require('pdf-parse/worker'); 

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const kb = require('./kb');

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

const OLLAMA_URL = 'http://localhost:11434/api/chat';
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

app.post('/api/ollama', async (req, res) => {
    const { message, pdfText, stream, kbEnabled } = req.body;

    if (!message) return res.status(400).json({ error: '请求参数缺失，请提供 message' });

    // 注意：不要在提示词里写"禁止输出思考过程"之类的指令——
    // 小模型会把自己的推理过程当成正文输出。正确做法是让模型正常思考，
    // 思考内容由 Ollama 放进独立的 message.thinking 字段，服务器只转发正文 content。
    let systemContent = pdfText
        ? `你是一个专业的C语言AI小助手，负责解答C语言问题、批改代码。下面是一份用户上传的PDF资料，请结合它回答问题：\n\n【PDF资料开始】\n${pdfText}\n【PDF资料结束】`
        : '你是一个专业的C语言AI小助手，负责解答C语言问题、批改代码。回答请简洁明了。';

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
            { role: 'user', content: message }
        ],
        stream: !!stream,
        think: true,           // 关键：明确开启思考，qwen3 会把思考放进独立的 message.thinking 字段（下方只取 content，思考内容不会到达前端）
        keep_alive: '30m'      // 提速：模型常驻显存/内存 30 分钟，避免每次请求都重新加载模型
    };

    try {
        console.log(`收到前端消息: ${message}${pdfText ? ' [附带PDF上下文]' : ''}${kbHitCount ? ` [课件命中${kbHitCount}段]` : ''}${stream ? ' [流式]' : ''}`);

        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Ollama 返回错误:', response.status, errText);
            return res.status(500).json({ error: 'Ollama 服务返回错误，请检查模型是否已加载' });
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
        console.error('调用 Ollama 出错:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: '本地 AI 服务暂时不可用，请确认 Ollama 已启动并已拉取对应模型' });
        } else {
            try { res.end(); } catch (e) {}
        }
    }
});

app.listen(port, () => {
    console.log(`Ollama 后端服务已启动: http://localhost:${port}`);
});