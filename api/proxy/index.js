// Azure Functions 代理服务
// 基于现有的 Vercel 代理服务修改

const fetch = require('node-fetch');
const { URL } = require('url');

// --- 配置 (从环境变量读取) ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // 默认 24 小时
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '5', 10); // 默认 5 层

// --- User Agent 处理 ---
// 默认 User Agent 列表
let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
// 尝试从环境变量读取并解析 USER_AGENTS_JSON
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        // 检查解析结果是否为非空数组
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents; // 使用环境变量中的数组
            console.log(`[代理日志] 已从环境变量加载 ${USER_AGENTS.length} 个 User Agent。`);
        } else {
            console.warn("[代理日志] 环境变量 USER_AGENTS_JSON 不是有效的非空数组，使用默认值。");
        }
    } else {
        console.log("[代理日志] 未设置环境变量 USER_AGENTS_JSON，使用默认 User Agent。");
    }
} catch (e) {
    // 如果 JSON 解析失败，记录错误并使用默认值
    console.error(`[代理日志] 解析环境变量 USER_AGENTS_JSON 出错: ${e.message}。使用默认 User Agent。`);
}

// 广告过滤在代理中禁用，由播放器处理
const FILTER_DISCONTINUITY = false;

// --- 辅助函数 ---

function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[代理日志] ${message}`);
    }
}

/**
 * 从代理请求路径中提取编码后的目标 URL。
 * @param {string} encodedPath - URL 编码后的路径部分 (例如 "https%3A%2F%2F...")
 * @returns {string|null} 解码后的目标 URL，如果无效则返回 null。
 */
function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) {
        logDebug("getTargetUrlFromPath 收到空路径。");
        return null;
    }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        // 基础检查，看是否像一个 HTTP/HTTPS URL
        if (decodedUrl.match(/^https?:\/\/.+/i)) {
            return decodedUrl;
        } else {
            logDebug(`无效的解码 URL 格式: ${decodedUrl}`);
            // 备选检查：原始路径是否未编码但看起来像 URL？
            if (encodedPath.match(/^https?:\/\/.+/i)) {
                logDebug(`警告: 路径未编码但看起来像 URL: ${encodedPath}`);
                return encodedPath;
            }
            return null;
        }
    } catch (e) {
        // 捕获解码错误 (例如格式错误的 URI)
        logDebug(`解码目标 URL 出错: ${encodedPath} - ${e.message}`);
        return null;
    }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        // 处理根目录或只有文件名的情况
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean); // 移除空字符串
        if (pathSegments.length <= 1) {
            return `${parsedUrl.origin}/`;
        }
        pathSegments.pop(); // 移除最后一段
        return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`获取 BaseUrl 失败: "${urlStr}": ${e.message}`);
        // 备用方法：查找最后一个斜杠
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) { // 确保不是协议部分的斜杠
            return urlStr.substring(0, lastSlashIndex + 1);
        }
        return urlStr + '/'; // 如果没有路径，添加斜杠
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return ''; // 处理空的 relativeUrl
    if (relativeUrl.match(/^https?:\/\/.+/i)) {
        return relativeUrl; // 已经是绝对 URL
    }
    if (!baseUrl) return relativeUrl; // 没有基础 URL 无法解析

    try {
        // 使用 Node.js 的 URL 构造函数处理相对路径
        return new URL(relativeUrl, baseUrl).toString();
    } catch (e) {
        logDebug(`URL 解析失败: base="${baseUrl}", relative="${relativeUrl}". 错误: ${e.message}`);
        // 简单的备用逻辑
        if (relativeUrl.startsWith('/')) {
             try {
                const baseOrigin = new URL(baseUrl).origin;
                return `${baseOrigin}${relativeUrl}`;
             } catch { return relativeUrl; } // 如果 baseUrl 也无效，返回原始相对路径
        } else {
            // 假设相对于包含基础 URL 资源的目录
            return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
        }
    }
}

// 确保生成 /proxy/ 前缀的链接
function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    // 返回与 staticwebapp.config.json 的 "route" 一致的路径
    return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchContentWithType(targetUrl, requestHeaders) {
    // 准备请求头
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*', // 传递原始 Accept 头（如果有）
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        // 尝试设置一个合理的 Referer
        'Referer': requestHeaders['referer'] || new URL(targetUrl).origin,
    };
    // 清理空值的头
    Object.keys(headers).forEach(key => headers[key] === undefined || headers[key] === null || headers[key] === '' ? delete headers[key] : {});

    logDebug(`准备请求目标: ${targetUrl}，请求头: ${JSON.stringify(headers)}`);

    try {
        // 发起 fetch 请求
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });

        // 检查响应是否成功
        if (!response.ok) {
            const errorBody = await response.text().catch(() => ''); // 尝试获取错误响应体
            logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
            // 创建一个包含状态码的错误对象
            const err = new Error(`HTTP 错误 ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status; // 将状态码附加到错误对象
            throw err; // 抛出错误
        }

        // 读取响应内容
        const content = await response.text();
        const contentType = response.headers.get('content-type') || '';
        logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${content.length}`);
        // 返回结果
        return { content, contentType, responseHeaders: response.headers };

    } catch (error) {
        // 捕获 fetch 本身的错误（网络、超时等）或上面抛出的 HTTP 错误
        logDebug(`请求异常 ${targetUrl}: ${error.message}`);
        // 重新抛出，确保包含原始错误信息
        throw new Error(`请求目标 URL 失败 ${targetUrl}: ${error.message}`);
    }
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
        return true;
    }
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl) {
    return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
    });
}

function processMapLine(line, baseUrl) {
     return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
    });
}

function processMediaPlaylist(url, content) {
    const baseUrl = getBaseUrl(url);
    if (!baseUrl) {
        logDebug(`无法确定媒体播放列表的基础 URL: ${url}. 无法处理相对路径.`);
    }

    const lines = content.split('\n');
    const output = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 处理空行，特别是最后一行
        if (!line) {
            if (i === lines.length - 1) {
                output.push(line); // 保留最后一个空行
            }
            continue;
        }

        // 处理 #EXT-X-KEY 行 (加密密钥)
        if (line.startsWith('#EXT-X-KEY')) {
            output.push(processKeyLine(line, baseUrl));
            continue;
        }

        // 处理 #EXT-X-MAP 行 (初始化段)
        if (line.startsWith('#EXT-X-MAP')) {
            output.push(processMapLine(line, baseUrl));
            continue;
        }

        // 处理 #EXTINF 行 (段信息)
        if (line.startsWith('#EXTINF')) {
            output.push(line);
            continue;
        }

        // 处理媒体段 URL (非注释行)
        if (!line.startsWith('#')) {
            const absoluteUrl = resolveUrl(baseUrl, line);
            logDebug(`重写媒体段: 原始='${line}', 解析后='${absoluteUrl}'`);
            output.push(rewriteUrlToProxy(absoluteUrl));
            continue;
        }

        // 其他行保持不变
        output.push(line);
    }

    return output.join('\n');
}

async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
    // 检测是主播放列表还是媒体播放列表
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
        logDebug(`检测到主播放列表: ${targetUrl} (深度: ${recursionDepth})`);
        return await processMasterPlaylist(targetUrl, content, recursionDepth);
    } else {
        logDebug(`检测到媒体播放列表: ${targetUrl} (深度: ${recursionDepth})`);
        return processMediaPlaylist(targetUrl, content);
    }
}

async function processMasterPlaylist(url, content, recursionDepth) {
    // 防止无限递归
    if (recursionDepth > MAX_RECURSION) {
        throw new Error(`超过最大递归深度 (${MAX_RECURSION}) 处理主播放列表: ${url}`);
    }

    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    
    // 查找最高带宽的变体流
    let highestBandwidth = -1;
    let bestVariantUrl = '';

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            // 提取带宽信息
            const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
            const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            
            // 查找下一个非注释行，它应该是变体 URI
            let variantUriLine = '';
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim();
                if (line && !line.startsWith('#')) {
                    variantUriLine = line;
                    i = j; // 跳过已处理的行
                    break;
                }
            }
            
            // 如果找到 URI 并且带宽更高，则更新最佳变体
            if (variantUriLine && currentBandwidth >= highestBandwidth) {
                highestBandwidth = currentBandwidth;
                bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
            }
        }
    }

    // 如果没有找到带宽信息，尝试使用第一个 .m3u8 URI
    if (!bestVariantUrl) {
        logDebug(`未找到 BANDWIDTH，尝试使用第一个 URI: ${url}`);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.startsWith('#') && line.match(/\.m3u8($|\?.*)/i)) {
                bestVariantUrl = resolveUrl(baseUrl, line);
                logDebug(`备用方案: 找到第一个子播放列表 URI: ${bestVariantUrl}`);
                break;
            }
        }
    }

    // 如果仍然没有找到有效的子播放列表，则将当前内容作为媒体播放列表处理
    if (!bestVariantUrl) {
        logDebug(`在主播放列表中未找到有效的子播放列表 URI: ${url}. 作为媒体播放列表处理.`);
        return processMediaPlaylist(url, content);
    }

    // 获取最佳变体的内容
    logDebug(`选择子播放列表 (带宽: ${highestBandwidth}): ${bestVariantUrl}`);
    const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});

    // 验证内容是否为 M3U8
    if (!isM3u8Content(variantContent, variantContentType)) {
        logDebug(`获取的子播放列表 ${bestVariantUrl} 不是 M3U8 (类型: ${variantContentType}). 作为媒体播放列表处理.`);
        return processMediaPlaylist(bestVariantUrl, variantContent);
    }

    // 递归处理子播放列表
    return await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}

// Azure Functions 处理函数
module.exports = async function (context, req) {
    context.log('Azure Functions 代理服务已启动');
    
    // 设置 CORS 头
    context.res = {
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*"
        }
    };

    // 处理 OPTIONS 请求
    if (req.method === 'OPTIONS') {
        context.log('处理 OPTIONS 请求');
        context.res.status = 204;
        context.res.body = '';
        return;
    }

    // 从路径中提取目标 URL
    const path = req.params.path || '';
    const targetUrl = getTargetUrlFromPath(path);
    
    if (!targetUrl) {
        context.log.error('无效的目标 URL');
        context.res.status = 400;
        context.res.body = '无效的目标 URL';
        return;
    }

    try {
        // 获取目标内容
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, req.headers || {});
        
        // 设置响应头
        Object.entries(responseHeaders).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'transfer-encoding') {
                context.res.headers[key] = value;
            }
        });
        
        // 处理 M3U8 内容
        if (isM3u8Content(content, contentType)) {
            context.log(`处理 M3U8 内容: ${targetUrl}`);
            const processedContent = await processM3u8Content(targetUrl, content);
            context.res.headers['Content-Type'] = 'application/vnd.apple.mpegurl';
            context.res.body = processedContent;
        } else {
            // 直接返回内容
            context.res.headers['Content-Type'] = contentType;
            context.res.body = content;
        }
        
    } catch (error) {
        context.log.error(`代理请求失败: ${error.message}`);
        context.res.status = error.status || 500;
        context.res.body = `代理请求失败: ${error.message}`;
    }
};