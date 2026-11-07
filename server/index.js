const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config(); // 如果你用 .env 文件存 token

const app = express();
const port = 3000; // 后端运行在 3000 端口

// 中间件
app.use(cors()); // 允许前端跨域请求
app.use(express.json()); // 解析 JSON 请求体

// 初始化魔塔 API 客户端
// 注意：把你完整的 ms- 令牌填在这里，或者写在 .env 文件里
const client = new OpenAI({
    apiKey: 'ms-c2b22f8d-7325-4228-9c09-6a2b7f75b628', // 替换为你的真实令牌
    baseURL: 'https://api-inference.modelscope.cn/v1'
});

// 处理聊天接口
app.post('/api/chat', async (req, res) => {
    const { message, stream, history } = req.body;

    if (!message) {
        return res.status(400).json({ error: '请求参数缺失，请提供 message' });
    }

    try {
        console.log(`收到前端消息: ${message}${stream ? ' [流式]' : ''}${Array.isArray(history) ? ` [上下文${history.length}条]` : ''}`);

        // 多轮上下文：白名单过滤 + 限长，避免异常数据把在线接口的 token 打满
        const historyMsgs = Array.isArray(history)
            ? history
                .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
                .slice(-12)
                .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))
            : [];
        const rawMessages = [
            { role: 'system', content: '你是一个专业的C语言AI小助手，负责解答C语言问题、批改代码。回答请简洁明了。' },
            ...historyMsgs,
            { role: 'user', content: message }
        ];
        // 合并连续同角色消息，兼容要求 messages 严格交替的在线接口
        const messages = [];
        for (const m of rawMessages) {
            const last = messages[messages.length - 1];
            if (last && last.role === m.role) last.content += '\n' + m.content;
            else messages.push({ role: m.role, content: m.content });
        }

        const params = {
            // 调用 Qwen3.5-35B-A3B 模型
            model: 'Qwen/Qwen3.5-35B-A3B',
            messages,
            temperature: 0.6,
            max_tokens: 2048,
        };

        // 非流式：保持原有 JSON 一次性返回（出题/图谱/总结报告等任务使用）
        if (!stream) {
            const response = await client.chat.completions.create(params);
            return res.json({ reply: response.choices[0].message.content });
        }

        // 流式：逐字推送给前端实时渲染，体感速度大幅提升（无需等全部生成完）
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');

        const completion = await client.chat.completions.create({ ...params, stream: true });
        for await (const chunk of completion) {
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
            if (delta) res.write(delta);
        }
        res.end();

    } catch (error) {
        console.error('调用 API 出错:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'AI 服务暂时不可用，请稍后再试' });
        } else {
            try { res.end(); } catch (e) {}
        }
    }
});

// 启动服务
app.listen(port, () => {
    console.log(`后端服务已启动: http://localhost:${port}`);
});

