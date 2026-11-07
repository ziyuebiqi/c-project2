// ================= 自有课件知识库核心模块 =================
// 零新增依赖：复用项目已有的 pdf-parse / mammoth / fs
// 职责：解析课件 -> 分块 -> 本地持久化 -> 轻量关键词检索 -> 组装提示词上下文
require('pdf-parse/worker');

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

const KB_DIR = path.join(__dirname, 'kb_data');
const KB_FILE = path.join(KB_DIR, 'kb.json');
const ALLOWED_EXT = ['.pdf', '.docx', '.txt', '.md'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// ================= 本地存储 =================
function readDB() {
    try {
        if (!fs.existsSync(KB_FILE)) return { docs: [], chunks: [] };
        const raw = fs.readFileSync(KB_FILE, 'utf8');
        const data = JSON.parse(raw);
        return { docs: data.docs || [], chunks: data.chunks || [] };
    } catch (e) {
        console.error('[知识库] 数据文件损坏，已重置:', e.message);
        return { docs: [], chunks: [] };
    }
}

function writeDB(data) {
    if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });
    fs.writeFileSync(KB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// multer / busboy 默认按 latin1 解码 multipart 文件名，浏览器发的中文名会变成乱码。
// 这里把 latin1 字节按 UTF-8 重新解码；已是正常中文或转不出有效中文时保持原样。
function fixFilename(name) {
    if (!name) return name;
    if (/[\u4e00-\u9fa5]/.test(name)) return name;
    try {
        const fixed = Buffer.from(name, 'latin1').toString('utf8');
        if (!fixed.includes('\uFFFD') && /[\u4e00-\u9fa5]/.test(fixed)) return fixed;
    } catch (e) {}
    return name;
}

// ================= 课件解析 =================
async function parseFile(file) {
    file.originalname = fixFilename(file.originalname);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
        throw new Error(`不支持的格式 ${ext}，目前支持 PDF / DOCX / TXT / MD`);
    }
    if (!file.buffer || !file.buffer.length) throw new Error('文件内容为空');
    if (file.buffer.length > MAX_FILE_SIZE) throw new Error('文件超过 20MB 限制');

    let text = '';
    if (ext === '.pdf') {
        const parser = new PDFParse({ data: file.buffer });
        try {
            const result = await parser.getText();
            text = (result.text || '').trim();
        } finally {
            await parser.destroy();
        }
    } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        text = (result.value || '').trim();
    } else {
        // TXT / Markdown 按 UTF-8 读取（如出现乱码，请用记事本另存为 UTF-8 编码）
        text = file.buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    }

    if (!text) throw new Error('未能从文件中提取到文字（扫描版 PDF 需先 OCR）');
    return text;
}

// ================= 文本分块 =================
// 按段落合并到约 450 字一块；超长段落按长度硬切，保证单块不会撑爆小模型上下文
function splitIntoChunks(text, target = 450, max = 700) {
    const clean = text
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ');

    const paras = clean.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const pieces = [];
    for (const p of paras) {
        if (p.length > max) {
            for (let i = 0; i < p.length; i += max) pieces.push(p.slice(i, i + max));
        } else {
            pieces.push(p);
        }
    }

    const chunks = [];
    let buf = '';
    for (const piece of pieces) {
        if (buf && (buf.length + piece.length + 1) > target) {
            chunks.push(buf.trim());
            buf = piece;
        } else {
            buf = buf ? buf + '\n' + piece : piece;
        }
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks.filter(c => c.length >= 15);
}

// ================= 文档管理 =================
function addDocument(file, text) {
    const db = readDB();
    const docId = 'd_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const now = new Date().toLocaleString();
    const chunks = splitIntoChunks(text);
    const fileName = fixFilename(file.originalname);

    const doc = {
        id: docId,
        name: fileName,
        ext: path.extname(fileName).toLowerCase(),
        size: file.size || file.buffer.length,
        time: now,
        enabled: true,
        charCount: text.length,
        chunkCount: chunks.length
    };

    chunks.forEach((t, i) => {
        db.chunks.push({
            id: `${docId}_c${i}`,
            docId,
            docName: doc.name,
            index: i,
            text: t
        });
    });
    db.docs.push(doc);
    writeDB(db);
    return doc;
}

function listDocuments() {
    const db = readDB();
    return {
        docs: db.docs,
        stats: {
            docCount: db.docs.length,
            enabledCount: db.docs.filter(d => d.enabled).length,
            chunkCount: db.chunks.length,
            totalChars: db.docs.reduce((s, d) => s + (d.charCount || 0), 0)
        }
    };
}

function deleteDocument(id) {
    const db = readDB();
    const before = db.docs.length;
    db.docs = db.docs.filter(d => d.id !== id);
    if (db.docs.length === before) return false;
    db.chunks = db.chunks.filter(c => c.docId !== id);
    writeDB(db);
    return true;
}

function toggleDocument(id, enabled) {
    const db = readDB();
    const doc = db.docs.find(d => d.id === id);
    if (!doc) return null;
    doc.enabled = !!enabled;
    writeDB(db);
    return doc;
}

function getChunks(id, limit = 50) {
    const db = readDB();
    return db.chunks.filter(c => c.docId === id).slice(0, limit);
}

// ================= 轻量关键词检索 =================
// 中文用 2-gram / 3-gram，英文数字用完整词；无需分词库、无需嵌入模型
const STOP_TERMS = new Set([
    '什么', '怎么', '如何', '为什么', '请帮', '帮我', '一下', '这个', '那个', '可以',
    '是否', '有关', '关于', '介绍', '解释', '说明', '请问', '告诉', '我想', '知道',
    '的', '了', '是', '在', '和', '有', '我', '你', '它', '吗', '呢', '请', '把', '给',
    '哪些', '哪些', '多少', '还有', '以及', '然后', '这个'
]);

function tokenize(query) {
    const terms = [];
    const seen = new Set();
    const push = (t, w) => {
        if (!t || seen.has(t) || STOP_TERMS.has(t)) return;
        seen.add(t);
        terms.push({ t, w });
    };

    const lower = query.toLowerCase();
    // 英文单词 / 数字 / C 语言关键字（如 printf、int、malloc、sizeof）
    (lower.match(/[a-z][a-z0-9_+#]{1,}|\d{2,}/g) || []).forEach(w => push(w, 3));

    // 中文连续片段：2-gram 打底、3-gram 加权提升区分度
    (query.match(/[\u4e00-\u9fa5]{2,}/g) || []).forEach(seg => {
        for (let i = 0; i < seg.length - 1; i++) push(seg.slice(i, i + 2), 1);
        for (let i = 0; i < seg.length - 2; i++) push(seg.slice(i, i + 3), 2);
    });

    return terms;
}

function search(query, topK = 4) {
    const db = readDB();
    const terms = tokenize(query || '');
    if (!terms.length || !db.chunks.length) return [];

    const enabledIds = new Set(db.docs.filter(d => d.enabled).map(d => d.id));
    const scored = [];

    for (const chunk of db.chunks) {
        if (!enabledIds.has(chunk.docId)) continue;
        const lower = chunk.text.toLowerCase();
        let score = 0;
        for (const term of terms) {
            let idx = 0, hits = 0;
            while ((idx = lower.indexOf(term.t, idx)) !== -1) {
                hits++;
                idx += term.t.length;
                if (hits >= 5) break;
            }
            if (hits) score += term.w * Math.min(hits, 4);
        }
        if (score <= 0) continue;
        // 长度归一化：避免长块仅因字数多就霸榜
        const normalized = score / Math.sqrt(chunk.text.length / 300 + 1);
        scored.push({ ...chunk, score: Math.round(normalized * 100) / 100 });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}

// 组装注入到 system prompt 的课件上下文（总量封顶，保护 4b 小模型）
function buildContext(query, topK = 4, maxChars = 2600) {
    const hits = search(query, topK);
    if (!hits.length) return { text: '', hits: [] };

    const parts = [];
    let used = 0;
    for (const h of hits) {
        const seg = `【片段 | ${h.docName} · 第${h.index + 1}段】\n${h.text}`;
        if (used + seg.length > maxChars) break;
        parts.push(seg);
        used += seg.length;
    }
    return { text: parts.join('\n\n'), hits: hits.slice(0, parts.length) };
}

module.exports = {
    ALLOWED_EXT,
    MAX_FILE_SIZE,
    parseFile,
    addDocument,
    listDocuments,
    deleteDocument,
    toggleDocument,
    getChunks,
    search,
    buildContext
};
