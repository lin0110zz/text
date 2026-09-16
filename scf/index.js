// 爱情音乐网页 - 在线搜索/播放后端代理（腾讯云 SCF 事件函数）
// 三源搜索：QQ音乐（结果最准、完整原版）+ 网易云（干净）+ 酷我（可免登录播放）
// 播放：QQ音乐结果→酷我同名兜底；网易云/酷我按source解析，失败跨平台兜底
// 播放统一 302 重定向到真实 CDN（强制 https，避免混合内容拦截）
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UPSTREAM_TIMEOUT = 12000;

// 通用 HTTP/HTTPS 请求（不自动跟随重定向，302 时从 headers.location 取地址）
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || UPSTREAM_TIMEOUT, () => req.destroy(new Error('上游请求超时')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

// CDN 直链统一升级为 https（页面是 https，避免音频被当作混合内容拦截）
function toHttps(u) {
  return String(u || '').replace(/^http:\/\//i, 'https://');
}

// 二进制 HTTP/HTTPS 请求（音频流代理专用：以 Buffer 收集，避免字符串拼接损坏二进制）
// 自动跟随最多 3 次重定向并保留请求头（如 Range）。
function httpsRequestBuffer(url, options = {}, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return reject(e); }
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = lib.request(reqOptions, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(httpsRequestBuffer(next, options, redirectsLeft - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || UPSTREAM_TIMEOUT, () => req.destroy(new Error('上游请求超时')));
    req.end();
  });
}

// base64url 编解码（用于在代理 URL 中安全传递 B站媒体地址）
function b64urlEncode(s) {
  return Buffer.from(String(s)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64').toString('utf8');
}

// 仅允许转发到 B站官方媒体 CDN 主机，防止代理被当作开放转发器（SSRF）
const MEDIA_HOST_RE = /(^|\.)(bilivideo\.com|bilivideo\.cn|akamaized\.net|mountaintoys\.cn)$/i;
// 每次最多向上游请求的字节数（base64 后约 1.37MB，远低于函数响应体限制），浏览器凭 206 自动续传
const MEDIA_CHUNK_BYTES = 1024 * 1024;

// B站音频流代理：浏览器直连 B站 CDN 会因 Referer 防盗链返回 403，
// 改由云函数携带正确 Referer 转发，并把媒体切成小的 Range 分片以规避响应体大小限制。
async function handleBvAudio(event) {
  const hdrs = {};
  for (const k of Object.keys((event && event.headers) || {})) hdrs[k.toLowerCase()] = event.headers[k];

  const fail = (code, msg) => ({
    isBase64Encoded: false,
    statusCode: code,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: msg }),
  });

  const query = (event && (event.queryString || event.queryStringParameters)) || {};

  let target = '';
  try { target = b64urlDecode(query.u || ''); } catch (e) { target = ''; }
  let targetUrl;
  try { targetUrl = new URL(target); } catch (e) { return fail(400, 'bad u'); }
  if (!MEDIA_HOST_RE.test(targetUrl.hostname)) return fail(403, 'host not allowed');

  // 解析浏览器请求的 Range，并把范围限制在单个分片内。
  let start = 0;
  let end = null;
  const m = /bytes=(\d*)-(\d*)/.exec(hdrs['range'] || '');
  if (m) {
    if (m[1]) start = parseInt(m[1], 10) || 0;
    if (m[2]) end = parseInt(m[2], 10);
  }
  const upEnd = end === null ? start + MEDIA_CHUNK_BYTES - 1 : Math.min(end, start + MEDIA_CHUNK_BYTES - 1);

  let up;
  try {
    up = await httpsRequestBuffer(target, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com/',
        'Range': `bytes=${start}-${upEnd}`,
      },
      timeout: UPSTREAM_TIMEOUT,
    });
  } catch (e) {
    return fail(502, 'upstream fetch failed');
  }

  const outHeaders = {
    ...CORS_HEADERS,
    'Content-Type': 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  let body = up.body;
  let status = up.statusCode;
  const cr = up.headers['content-range'];
  if (cr) {
    outHeaders['Content-Range'] = cr;
  } else if (status === 200) {
    // 上游忽略 Range 返回全量时，截断为单个分片并自行构造 206，保证响应体不超限。
    const total = body.length;
    body = body.slice(0, MEDIA_CHUNK_BYTES);
    status = 206;
    outHeaders['Content-Range'] = `bytes 0-${body.length - 1}/${total}`;
  }

  return {
    isBase64Encoded: true,
    statusCode: status,
    headers: outHeaders,
    body: body.toString('base64'),
  };
}

// 清理歌名/歌手里的转义字符与 HTML 实体
function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\u0026/gi, '&')
    .replace(/\\&/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从一条酷我记录块里提取字段（返回单引号类 JSON）
function pickField(block, key) {
  const m = block.match(new RegExp("'" + key + "':'?([^',}]*)'?"));
  return m ? m[1] : '';
}

// 有声书/电台判定：audiobookpayinfo.play=1 或 feeType.bookvip=1
function isAudiobook(block) {
  const ab = block.match(/'audiobookpayinfo':\{([^}]*)\}/);
  if (ab && /'play':'1'/.test(ab[1])) return true;
  const fee = block.match(/'feeType':\{([^}]*)\}/);
  if (fee && /'bookvip':'1'/.test(fee[1])) return true;
  return false;
}

// 明显不是歌曲的版本后缀（片段/搞笑/伴奏/教材等）
const BAD_SUFFIX = /片段|搞笑|奥特曼|助眠|纯音乐|伴奏|カラオケ|卡拉OK|教学|教程|铃声|预览|demo|采样|堵桥|砸桌子|拍杯子|清唱|翻奏|口哨|八音盒|儿歌|睡前|哄睡|截取|秒版|年级|上册|下册|课本|语文|数学|英语教材|第\s*\d+\s*课/i;
// 改编版本后缀（DJ/live/乐器版等）
const COVER_SUFFIX = /dj|remix|live|现场|演唱会|巡回|盛典|音乐节|翻唱|cover|钢琴|古筝|二胡|琵琶|笛子|吉他|架子鼓|萨克斯|小提琴|口琴|女生版|男生版|女声|男声|加速|减速|变速|卡点|热播|混音|电音|蹦迪|旋律版|和声|inst(\b|rumental)/i;
// 非真人/泛创作者歌手
const GENERIC_ARTIST = /网络歌手|纯音乐|助眠|哄睡|睡前|故事会?|宝宝巴士|儿童|儿歌|有声|群星|合辑|未知|铃声|挖掘机|轻音乐|解压|播音|演奏|翻唱|^各种|音乐达人|^小小$|^佚名$/i;
// 有声平台歌手
const AUDIOBOOK_ARTIST = /喜马拉雅|蜻蜓|懒人听书|有声书|得到|蜻蜓FM/i;

// 原唱/正版优先打分
function scoreSong(song, kw) {
  let score = 0;
  const name = song.name || '';
  const artist = song.artist || '';
  const nameNS = name.replace(/\s+/g, '').toLowerCase();
  const artistNS = artist.replace(/\s+/g, '').toLowerCase();
  const kwNS = kw.replace(/\s+/g, '').toLowerCase();
  const tokens = kw.split(/[\s,，&+×x*\-—、/]+/).map(t => t.replace(/\s+/g, '').toLowerCase()).filter(t => t.length >= 1);
  const base = name.split(/[(（【]/)[0].replace(/\s+/g, '').toLowerCase();
  const hasVer = /[(（【]/.test(name) || BAD_SUFFIX.test(name) || COVER_SUFFIX.test(name);

  // 1 歌手+歌名双命中（如“周杰伦 稻香”）→ 最高精准
  if (tokens.length >= 2) {
    const baseHit = tokens.includes(base);
    const other = tokens.filter(t => t !== base);
    if (baseHit && other.some(t => artistNS.includes(t))) score += 130;
  }
  // 2 主歌名匹配
  if (base === kwNS) score += 100;
  else if (tokens.includes(base)) score += 80;
  else if (nameNS.includes(kwNS)) score += 30;
  else if (kwNS.includes(base) && base.length >= 2) score += 15;
  // 3 歌手匹配
  if (artistNS && artistNS === kwNS) score += 55;
  else if (artistNS && tokens.some(t => artistNS.includes(t))) score += 25;
  // 4 干净原版（无版本后缀）
  if (!hasVer) score += 45;
  // 5 后缀降权
  if (BAD_SUFFIX.test(name)) score -= 70;
  if (COVER_SUFFIX.test(name)) score -= 28;
  // 6 空歌手 / 泛创作者降权
  if (!artist.trim()) score -= 40;
  else if (GENERIC_ARTIST.test(artist)) score -= 38;
  // 7 时长：过短片段/铃声 大幅降权，正常流行歌时长(3-5分钟)加分
  if (song.duration > 0) {
    if (song.duration < 60) score -= 80;       // 1分钟内：铃声/片段
    else if (song.duration < 100) score -= 50;  // 1-1.7分钟：片段/高潮版
    else if (song.duration >= 180 && song.duration <= 360) score += 20; // 3-6分钟：正常完整歌曲
    else if (song.duration > 600) score -= 20;  // 超10分钟：串烧/合集
  }
  // 8 播放量轻微加权（老接口数据失真，权重很低）
  if (song.playcnt > 0) score += Math.log10(song.playcnt + 1) * 2;
  return score;
}

// 统一路由：事件函数与 Web 函数共用。输入归一化的 event，返回集成响应对象。
async function router(event) {
  const ev = event || {};
  const rc = ev.requestContext || {};
  const path = ev.path || rc.path || ev.rawPath || (rc.http && rc.http.path) || '/';
  const method = ev.httpMethod || rc.httpMethod || (rc.http && rc.http.method) || 'GET';
  const query = ev.queryString || ev.queryStringParameters || {};

  if (method === 'OPTIONS') {
    return { isBase64Encoded: false, statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (path.includes('/api/search') || path === '/search') {
    return handleSearch(query);
  } else if (path.includes('/api/playlist') || path === '/playlist') {
    return handlePlaylist(query);
  } else if (path.includes('/api/play') || path === '/play') {
    return handlePlay(query);
  } else if (path.includes('/api/bvaudio') || path === '/bvaudio') {
    return handleBvAudio(ev);
  } else if (path.includes('/api/bv') || path === '/bv') {
    return handleBv(query, ev);
  }

  return {
    isBase64Encoded: false,
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, version: 'v7-qq-search', path }),
  };
}

// 事件函数入口（函数 URL / API 网关触发器）
exports.main_handler = async (event, context) => router(event);

/* ===================== 酷我（主音源） ===================== */

// 单次酷我老版搜索，返回过滤后的歌曲数组
async function searchKuwoOnce(kw) {
  const url = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(kw)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=30&rformat=json&encoding=utf8`;
  const resp = await httpsRequest(url, { headers: { 'User-Agent': UA } });
  const blocks = (resp.body || '').split(/(?='DC_TARGETID')/).slice(1);
  const out = [];
  for (const b of blocks) {
    const id = pickField(b, 'DC_TARGETID');
    if (!id) continue;
    if (pickField(b, 'DC_TARGETTYPE') !== 'music') continue;
    if (isAudiobook(b)) continue; // 过滤有声书/电台
    const artist = cleanText(pickField(b, 'ARTIST'));
    if (AUDIOBOOK_ARTIST.test(artist)) continue;
    out.push({
      id,
      name: cleanText(pickField(b, 'SONGNAME')),
      artist,
      album: cleanText(pickField(b, 'ALBUM')),
      duration: parseInt(pickField(b, 'DURATION') || '0', 10) || 0,
      playcnt: parseInt(pickField(b, 'PLAYCNT') || '0', 10) || 0,
      cover: pickField(b, 'htS_MOVE') || '',
      source: 'kuwo',
    });
  }
  return out;
}

// 酷我 antiserver 换播放地址（format: mp3 / wma）
async function kuwoResolve(id, format) {
  try {
    const u = `http://antiserver.kuwo.cn/anti.s?type=convert_url&format=${format}&response=url&rid=MUSIC_${encodeURIComponent(id)}`;
    const resp = await httpsRequest(u, { headers: { 'User-Agent': UA }, timeout: 10000 });
    const real = (resp.body || '').trim();
    if (resp.statusCode === 200 && real.startsWith('http')) return toHttps(real);
    return '';
  } catch (e) {
    return '';
  }
}

// 按歌名/歌手在酷我找最佳匹配并换地址
async function kuwoResolveByName(name, artist) {
  try {
    const kw = artist ? `${artist} ${name}` : name;
    const list = await searchKuwoOnce(kw);
    if (!list.length) return '';
    list.forEach(s => { s.score = scoreSong(s, kw); });
    list.sort((a, b) => b.score - a.score);
    const best = list[0];
    if (best.score < 60) return ''; // 匹配度太低不用
    return await kuwoResolve(best.id, 'mp3') || await kuwoResolve(best.id, 'wma');
  } catch (e) {
    return '';
  }
}

/* ===================== 网易云（备用音源） ===================== */

// 网易云搜索
async function searchNetease(kw) {
  const body = `s=${encodeURIComponent(kw)}&type=1&offset=0&limit=30`;
  const resp = await httpsRequest('https://music.163.com/api/search/get', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Referer': 'https://music.163.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
    timeout: 10000,
  });
  const j = JSON.parse(resp.body);
  const arr = (j && j.result && j.result.songs) || [];
  return arr.map(s => ({
    id: String(s.id),
    name: cleanText(s.name),
    artist: cleanText((s.artists || []).map(a => a.name).join('、')),
    album: cleanText(s.album && s.album.name),
    duration: Math.round((s.duration || 0) / 1000),
    playcnt: 0,
    cover: (s.album && s.album.picUrl) || '',
    source: 'netease',
  }));
}

// 网易云外链解析：outer/url 302 到 CDN；VIP/无版权会 302 到 /404
async function neteaseResolve(id) {
  try {
    const resp = await httpsRequest(`https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`, {
      headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' },
      timeout: 10000,
    });
    let loc = resp.headers && resp.headers.location ? resp.headers.location : '';
    if (!loc) return '';
    if (/\/404/i.test(loc) || !/music\.126\.net/i.test(loc)) return ''; // 无版权/VIP
    return toHttps(loc);
  } catch (e) {
    return '';
  }
}

// 按歌名/歌手在网易云找最佳匹配并解析
async function neteaseResolveByName(name, artist) {
  try {
    const kw = artist ? `${artist} ${name}` : name;
    const list = await searchNetease(kw);
    if (!list.length) return '';
    list.forEach(s => { s.score = scoreSong(s, kw); });
    list.sort((a, b) => b.score - a.score);
    // 依次尝试前 3 个候选（首个可能是 VIP 跳 404）
    for (const cand of list.slice(0, 3)) {
      if (cand.score < 60) break;
      const u = await neteaseResolve(cand.id);
      if (u) return u;
    }
    return '';
  } catch (e) {
    return '';
  }
}

/* ===================== QQ音乐（搜索质量最高，播放需登录→兜底酷我） ===================== */

async function searchQQ(kw) {
  try {
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(kw)}&format=json&p=1&n=30`;
    const resp = await httpsRequest(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/' },
      timeout: UPSTREAM_TIMEOUT,
    });
    const j = JSON.parse(resp.body);
    const list = (j && j.data && j.data.song && j.data.song.list) || [];
    return list.map(s => ({
      id: String(s.songmid || ''),
      name: cleanText(s.songname || ''),
      artist: cleanText((s.singer || []).map(a => a.name).join('、')),
      album: cleanText(s.album && s.album.name ? s.album.name : (s.albumname || '')),
      duration: s.interval || 0,
      playcnt: 0,
      cover: '',
      source: 'qq',
    })).filter(s => s.id);
  } catch (e) {
    return [];
  }
}

/* ===================== 搜索接口 ===================== */

async function handleSearch(query) {
  const keyword = query.keyword || query.q || '';
  if (!keyword || !keyword.trim()) {
    return jsonResp(400, { code: 0, error: '请输入关键词' });
  }

  const kw = keyword.trim();
  try {
    // 酷我：含空格/分隔符时（可能是"歌手 歌名"），并行搜索完整词+各分词，补回被接口漏掉的原版
    const segs = kw.split(/[\s,，&+×x*\-—、/]+/).map(s => s.trim()).filter(s => s.length >= 2 && s !== kw);
    const kuwoQueries = [...new Set([kw, ...segs])].slice(0, 4);

    // 并行：QQ音乐 + 网易云 + 酷我多查询搜索
    const allResults = await Promise.all([
      searchQQ(kw).catch(() => []),
      searchNetease(kw).catch(() => []),
      ...kuwoQueries.map(q => searchKuwoOnce(q).catch(() => [])),
    ]);
    const qqList = allResults[0];
    const neList = allResults[1];
    const kuwoLists = allResults.slice(2);

    // 酷我多查询结果按 id 去重合并
    const kuwoMap = new Map();
    for (const list of kuwoLists) {
      for (const s of list) {
        if (!kuwoMap.has(s.id)) kuwoMap.set(s.id, s);
      }
    }
    const kwList = [...kuwoMap.values()];

    // 过滤：有声平台歌手 / 片段教材后缀 / 过短铃声(80秒以下)
    const filterBad = (s) => {
      if (AUDIOBOOK_ARTIST.test(s.artist || '')) return false;
      if (BAD_SUFFIX.test(s.name || '')) return false;
      if (s.duration > 0 && s.duration < 80) return false; // 铃声/片段版
      return true;
    };
    let songs = [...qqList.filter(filterBad), ...neList.filter(filterBad), ...kwList.filter(filterBad)];

    // 跨平台去重：按 歌名|歌手 去重，优先级 QQ(信息最准) > 酷我(可播放) > 网易云
    const PRIORITY = { qq: 3, kuwo: 2, netease: 1 };
    const seen = new Map();
    for (const s of songs) {
      const key = (s.name || '').replace(/\s+/g, '').toLowerCase() + '|' + (s.artist || '').replace(/\s+/g, '').toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, s);
      } else {
        const old = seen.get(key);
        if ((PRIORITY[s.source] || 0) > (PRIORITY[old.source] || 0)) seen.set(key, s);
      }
    }
    songs = [...seen.values()];

    // 原唱/正版优先打分
    songs.forEach(s => { s.score = scoreSong(s, kw); });
    // QQ音乐来源的干净原版额外加分（信息最准、通常是完整原版）
    // 酷我来源的干净原版额外加分（可免登录播放）
    songs.forEach(s => {
      const nm = s.name || '';
      const hasVer = nm.includes('(') || nm.includes('（') || nm.includes('【') || COVER_SUFFIX.test(nm) || BAD_SUFFIX.test(nm);
      if (!hasVer && s.artist && s.artist.trim()) {
        if (s.source === 'qq') s.score += 60;
        else if (s.source === 'kuwo') s.score += 40;
      }
    });
    songs.sort((a, b) => b.score - a.score);

    const finalSongs = songs.slice(0, 30).map(s => ({
      id: s.id, name: s.name, artist: s.artist, album: s.album,
      duration: s.duration, cover: s.cover, source: s.source || 'netease',
    }));

    return jsonResp(200, { code: 1, keyword: kw, count: finalSongs.length, songs: finalSongs });
  } catch (e) {
    return jsonResp(500, { code: 0, error: '搜索服务暂时不可用，请稍后重试', detail: e.message });
  }
}

/* ===================== 播放接口（多平台 fallback） ===================== */

async function handlePlay(query) {
  const id = query.id;
  if (!id) {
    return jsonResp(400, { error: '缺少 id 参数' });
  }
  const source = (query.source || 'netease').toLowerCase();
  const name = query.name ? cleanText(query.name) : '';
  const artist = query.artist ? cleanText(query.artist) : '';

  try {
    let realUrl = '';

    if (source === 'qq') {
      // QQ音乐播放需登录态，直接用歌名/歌手去酷我找可播放地址
      if (name) realUrl = await kuwoResolveByName(name, artist);
      if (!realUrl && name) realUrl = await neteaseResolveByName(name, artist);
    } else if (source === 'netease') {
      // 网易云直解 → 失败回退酷我同名
      realUrl = await neteaseResolve(id);
      if (!realUrl && name) realUrl = await kuwoResolveByName(name, artist);
    } else {
      // 酷我 mp3 → wma → 网易云同名兜底
      realUrl = await kuwoResolve(id, 'mp3');
      if (!realUrl) realUrl = await kuwoResolve(id, 'wma');
      if (!realUrl && name) realUrl = await neteaseResolveByName(name, artist);
    }

    if (realUrl && realUrl.startsWith('http')) {
      return {
        isBase64Encoded: false,
        statusCode: 302,
        headers: { ...CORS_HEADERS, 'Location': realUrl, 'Cache-Control': 'no-cache' },
        body: '',
      };
    }

    return jsonResp(404, { error: '未获取到播放地址，该歌曲可能为 VIP 专享或已下架' });
  } catch (e) {
    return jsonResp(500, { error: '播放代理出错', detail: e.message });
  }
}


/* ===================== B站公开视频音轨 ===================== */

// 仅处理公开、可直接播放的视频：通过 B站公开接口拿到首P的 DASH 音频轨。
// 不绕过会员、付费、登录或其它访问限制；没有公开音轨时直接返回错误。
async function handleBv(query, event) {
  const raw = String(query.bvid || query.bv || query.id || '').trim();
  const m = raw.match(/BV[0-9A-Za-z]{10}/i);
  const bvid = m ? m[0] : '';
  if (!bvid) return jsonResp(400, { error: '请输入正确的 BV 号或 B站视频链接' });

  // 函数自身对外地址，用于把 B站音频直链包装成带 Referer 的代理地址
  const evHdrs = (event && event.headers) || {};
  const selfHost = evHdrs.Host || evHdrs.host || evHdrs.HOST || '1489001692-hrizux5309.ap-guangzhou.tencentscf.com';
  const fwdProto = evHdrs['x-forwarded-proto'] || evHdrs['X-Forwarded-Proto'];
  const isLocalHost = /^(localhost|127\.|192\.168\.|10\.|0\.0\.0\.0)/i.test(selfHost);
  const selfProto = fwdProto || (isLocalHost ? 'http' : 'https');
  const selfBase = `${selfProto}://${selfHost}`;

  try {
    const viewResp = await httpsRequest(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' }, timeout: UPSTREAM_TIMEOUT }
    );
    const view = JSON.parse(viewResp.body || '{}');
    if (view.code !== 0 || !view.data) {
      return jsonResp(404, { error: '视频不存在、不可见或暂时无法获取信息' });
    }

    const pages = Array.isArray(view.data.pages) ? view.data.pages : [];
    const page = pages[0];
    if (!page || !page.cid) {
      return jsonResp(404, { error: '没有找到可播放的视频分P' });
    }

    // ① 先请求 DURL 合并视频文件，供 FFmpeg 直接分离原音轨。
    const durlApi =
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${encodeURIComponent(page.cid)}&fnval=0&fnver=0&fourk=0`;
    const durlResp = await httpsRequest(durlApi, {
      headers: { 'User-Agent': UA, 'Referer': `https://www.bilibili.com/video/${bvid}/` },
      timeout: UPSTREAM_TIMEOUT,
    });
    const durlJson = JSON.parse(durlResp.body || '{}');
    const durlItem = durlJson && durlJson.data && Array.isArray(durlJson.data.durl) ? durlJson.data.durl[0] : null;
    const videoUrl = durlItem && durlItem.url ? toHttps(durlItem.url) : '';

    // ② 再请求 DASH 独立音频轨（云函数环境通常没有 FFmpeg，这是主要可用路径）。
    let audioUrl = '';
    try {
      const dashApi =
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
        `&cid=${encodeURIComponent(page.cid)}&fnval=16&fnver=0&fourk=1`;
      const dashResp = await httpsRequest(dashApi, {
        headers: { 'User-Agent': UA, 'Referer': `https://www.bilibili.com/video/${bvid}/` },
        timeout: UPSTREAM_TIMEOUT,
      });
      const dashJson = JSON.parse(dashResp.body || '{}');
      const audios = dashJson && dashJson.data && dashJson.data.dash && Array.isArray(dashJson.data.dash.audio)
        ? dashJson.data.dash.audio : [];
      // 取码率最高的独立音频轨。
      const best = audios
        .filter(a => a && (a.baseUrl || a.base_url))
        .sort((x, y) => (y.bandwidth || 0) - (x.bandwidth || 0))[0];
      if (best) audioUrl = toHttps(best.baseUrl || best.base_url);
    } catch (e) {
      // DASH 请求失败时继续尝试 FFmpeg 路径。
    }

    // ③ 如果拿到了视频文件且环境装有 FFmpeg，优先直接复制原音轨；输出较小才内联，
    // 避免把超大的媒体文件塞进云函数 JSON 响应。失败则使用 DASH 独立音轨。
    if (videoUrl) {
      try {
        const ff = await extractAudioInline(videoUrl, {
          referer: `https://www.bilibili.com/video/${bvid}/`,
          maxBytes: 8 * 1024 * 1024,
        });
        if (ff && ff.dataUrl) {
          return jsonResp(200, {
            code: 1, bvid, cid: String(page.cid),
            title: cleanText(view.data.title || page.part || bvid),
            duration: Number(page.duration || 0),
            audio: ff.dataUrl,
            format: 'M4A (FFmpeg copy)',
            pipeline: 'ffmpeg-copy',
            note: '仅处理公开接口可取得且你有权使用的媒体；FFmpeg 使用 -c:a copy 分离原音轨，不重新编码。',
          });
        }
      } catch (e) {
        // FFmpeg 不可用/输出过大时继续走公开独立音频轨，不影响正常播放。
      }
    }

    if (!audioUrl) {
      return jsonResp(403, {
        error: '没有获取到可直接使用的媒体，可能需要登录、会员/付费权限或受到其它访问限制。',
      });
    }

    // ④ B站 DASH 独立音频轨：B站 CDN 校验 Referer，浏览器直连会 403，
    // 因此包装成云函数代理地址（携带正确 Referer 并分片转发），可直接放进 <audio> 播放。
    const proxiedAudio = `${selfBase}/api/bvaudio?u=${b64urlEncode(audioUrl)}`;
    return jsonResp(200, {
      code: 1,
      bvid,
      cid: String(page.cid),
      title: cleanText(view.data.title || page.part || bvid),
      duration: Number(page.duration || 0),
      audio: proxiedAudio,
      format: 'DASH audio (proxied)',
      pipeline: 'direct-audio-proxy',
      note: 'B站公开独立音频轨经云函数代理转发，已携带正确 Referer，支持拖动与续播；不绕过访问限制。',
    });
  } catch (e) {
    return jsonResp(502, { error: '获取B站公开音轨失败，请稍后重试', detail: e.message });
  }
}

/* ===================== 网易云歌单同步 ===================== */

// 从用户输入中提取歌单ID（支持完整链接、短链、纯ID）
function extractPlaylistId(input) {
  if (!input) return '';
  const s = String(input).trim();
  // 纯数字ID
  if (/^\d+$/.test(s)) return s;
  // 从链接中提取 id=数字
  const m = s.match(/[?&]id=(\d+)/);
  if (m) return m[1];
  // 从路径中提取 /playlist/数字
  const m2 = s.match(/\/playlist\/(\d+)/);
  if (m2) return m2[1];
  return '';
}

async function fetchPlaylist(id) {
  try {
    const url = `https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`;
    const resp = await httpsRequest(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://music.163.com/',
        'Cookie': 'os=pc; appver=2.10.12; osver=Microsoft-Windows-10-Professional-build-22631-64bit; channel=netease; MUSIC_U=; __remember_me=true;',
      },
      timeout: UPSTREAM_TIMEOUT,
    });
    const j = JSON.parse(resp.body);
    const pl = j && j.result;
    if (!pl) return { name: '', songs: [] };
    const tracks = pl.tracks || [];
    const songs = tracks.map(t => ({
      id: String(t.id || ''),
      name: cleanText(t.name || ''),
      artist: cleanText((t.ar || t.artists || []).map(a => a.name).join('、')),
      album: cleanText((t.al && t.al.name) || (t.album && t.album.name) || ''),
      duration: Math.round((t.dt || t.duration || 0) / 1000),
      cover: (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || '',
      source: 'netease',
    })).filter(s => s.id && s.name);
    return { name: cleanText(pl.name || '网易云歌单'), cover: pl.coverImgUrl || '', count: songs.length, songs };
  } catch (e) {
    return { name: '', songs: [], error: e.message };
  }
}


async function extractAudioInline(inputUrl, options = {}) {
  const maxBytes = options.maxBytes || (8 * 1024 * 1024);
  const headers = 'Referer: https://www.bilibili.com/\r\nOrigin: https://www.bilibili.com\r\n';
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-user_agent', UA,
      '-headers', headers,
      '-i', inputUrl,
      '-vn', '-c:a', 'copy',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'ipod', 'pipe:1',
    ];
    const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg';
    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let stderr = '';
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        child.kill('SIGKILL');
        fail(new Error('FFmpeg输出超过内联大小限制'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString().slice(-4000); });
    child.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      if (code !== 0 || !chunks.length) return fail(new Error(stderr || 'FFmpeg 提取失败'));
      settled = true;
      const buf = Buffer.concat(chunks);
      resolve({ dataUrl: 'data:audio/mp4;base64,' + buf.toString('base64'), bytes: buf.length });
    });
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      fail(new Error('FFmpeg 提取超时'));
    }, 20000);
  });
}

async function handlePlaylist(query) {
  const raw = query.id || query.url || query.link || '';
  const id = extractPlaylistId(raw);
  if (!id) {
    return jsonResp(400, { code: 0, error: '请提供有效的网易云歌单链接或ID' });
  }
  try {
    const result = await fetchPlaylist(id);
    if (result.error) {
      return jsonResp(502, { code: 0, error: '获取歌单失败：' + result.error });
    }
    if (!result.songs.length) {
      return jsonResp(404, { code: 0, error: '歌单为空或不存在（私密歌单需登录）' });
    }
    return jsonResp(200, {
      code: 1,
      playlist_id: id,
      name: result.name,
      cover: result.cover,
      count: result.songs.length,
      songs: result.songs,
    });
  } catch (e) {
    return jsonResp(500, { code: 0, error: '歌单服务出错', detail: e.message });
  }
}

function jsonResp(statusCode, obj) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

/* ===================== Web 函数 HTTP 服务 ===================== */
// 当作为 Web 函数直接运行（node index.js）时启动常驻 HTTP 服务；
// 平台直接透传 HTTP 请求/响应，因此能正确返回二进制音频流与 206 Range。
// 事件函数入口 exports.main_handler 不受影响，同一份代码两种部署方式通用。
if (require.main === module) {
  const PORT = process.env.PORT || process.env.SCF_PORT || 9000;

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const u = new URL(req.url, 'http://localhost');
      const queryString = {};
      for (const [k, v] of u.searchParams) queryString[k] = v;

      const event = {
        httpMethod: req.method,
        path: u.pathname,
        rawPath: u.pathname,
        queryString,
        headers: req.headers, // Node 已统一为小写
        body: rawBody || null,
      };

      const resp = await router(event);

      res.statusCode = resp.statusCode || 200;
      const hdrs = resp.headers || {};
      for (const [k, v] of Object.entries(hdrs)) {
        if (v === undefined || v === null) continue;
        try { res.setHeader(k, v); } catch (e) { /* 忽略非法头部 */ }
      }

      const out = resp.isBase64Encoded
        ? Buffer.from(resp.body == null ? '' : resp.body, 'base64')
        : Buffer.from(resp.body == null ? '' : String(resp.body), 'utf8');
      res.removeHeader('Content-Length');
      res.setHeader('Content-Length', out.length);
      res.end(out);
    } catch (e) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'gateway error', detail: String((e && e.message) || e) }));
    }
  });

  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* noop */ }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`lovezz-api web server listening on 0.0.0.0:${PORT}`);
  });
}
