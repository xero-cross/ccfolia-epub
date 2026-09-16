/* parser.js — 코코포리아(ccfolia) 로그 HTML → 정규화 데이터
 *
 * 지원 형식
 *  - 신형: <article class="message" data-channel="..."> 구조 (아바타 base64 포함)
 *  - 구형: <p style="color:#hex"><span>[탭]</span><span>발언자</span><span>본문</span></p>
 *
 * 결과
 *  {
 *    format: 'new' | 'classic',
 *    title: '책 제목',
 *    lang: 'ko',
 *    avatars: { className: dataURI, ... },
 *    channels: [ { id, name, count } ],           // 등장 순서
 *    messages: [ { idx, channelId, system, avatar, speaker, color, time, timeText, text, roll, edited } ],
 *    warnings: [ '...' ],
 *    stats: { messages, channels, avatars, hasTimestamps }
 *  }
 */
(function (global) {
  'use strict';

  var BRACKET_RE = /^\s*[\[［]\s*([\s\S]*?)\s*[\]］]\s*$/;
  var TITLE_TAIL_RE = /^([\s\S]*?)\s*[\[［]([^\[\]［］]*)[\]］]\s*$/;
  var CSS_BG_RE = /\.([A-Za-z0-9_\-]+)\s*\{[^{}]*?background(?:-image)?\s*:\s*url\(\s*["']?(data:image\/[A-Za-z0-9.+\-]+;base64,[A-Za-z0-9+\/=\s]+?)["']?\s*\)/g;
  var INLINE_BG_RE = /url\(\s*["']?(data:image\/[A-Za-z0-9.+\-]+;base64,[A-Za-z0-9+\/=\s]+?)["']?\s*\)/;
  var COLOR_OK_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;
  var CHUNK = 1500;

  function stripBrackets(s) {
    var str = String(s == null ? '' : s);
    var m = str.match(BRACKET_RE);
    return (m ? m[1] : str).replace(/\s+/g, ' ').trim();
  }

  function splitTitle(raw) {
    var t = String(raw || '').replace(/\s+/g, ' ').trim();
    var m = t.match(TITLE_TAIL_RE);
    if (m && m[1].trim()) return { base: m[1].trim(), tail: m[2].trim() };
    return { base: t, tail: null };
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
  }

  // 요소의 표시 텍스트. <br>, 블록 요소는 줄바꿈으로 변환.
  function elementText(el) {
    if (!el) return '';
    var text;
    if (el.querySelector('br, p, div, li')) {
      var clone = el.cloneNode(true);
      var brs = clone.querySelectorAll('br');
      for (var i = 0; i < brs.length; i++) brs[i].replaceWith('\n');
      var blocks = clone.querySelectorAll('p, div, li');
      for (var j = 0; j < blocks.length; j++) blocks[j].append('\n');
      text = clone.textContent;
    } else {
      text = el.textContent;
    }
    return normalizeText(text);
  }

  function sanitizeColor(c) {
    if (!c) return null;
    var s = String(c).trim();
    return COLOR_OK_RE.test(s) ? s : null;
  }

  function extractColor(el) {
    var style = el.getAttribute('style') || '';
    var m = style.match(/--speaker-color\s*:\s*([^;]+)/);
    if (m) return sanitizeColor(m[1]);
    m = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
    if (m) return sanitizeColor(m[1]);
    try { if (el.style && el.style.color) return sanitizeColor(el.style.color); } catch (e) { /* ignore */ }
    return null;
  }

  // <style> 안의 "클래스 → data URI" 규칙을 모두 수집
  function extractAvatarMap(doc) {
    var map = {};
    var styles = doc.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var css = styles[i].textContent || '';
      CSS_BG_RE.lastIndex = 0;
      var m;
      while ((m = CSS_BG_RE.exec(css))) {
        if (!map[m[1]]) map[m[1]] = m[2].replace(/\s+/g, '');
      }
    }
    return map;
  }

  function detectFormat(doc) {
    if (doc.querySelector('article.message')) return 'new';
    var ps = doc.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      var spans = directSpans(ps[i]);
      if (spans.length >= 3 && BRACKET_RE.test(spans[0].textContent)) return 'classic';
    }
    return null;
  }

  function directSpans(p) {
    var out = [];
    for (var c = p.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName === 'SPAN') out.push(c);
    }
    return out;
  }

  function classicNodes(doc) {
    var out = [];
    var ps = doc.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      var spans = directSpans(ps[i]);
      if (spans.length >= 3 && BRACKET_RE.test(spans[0].textContent)) out.push(ps[i]);
    }
    return out;
  }

  function rollClass(el) {
    var cl = el.classList;
    if (cl.contains('critical')) return 'critical';
    if (cl.contains('fumble')) return 'fumble';
    if (cl.contains('success')) return 'success';
    if (cl.contains('failure')) return 'failure';
    return '';
  }

  function makeAvatarRegistry(avatars) {
    var byUri = new Map();
    Object.keys(avatars).forEach(function (k) { byUri.set(avatars[k], k); });
    var seq = 0;
    return {
      byClass: function (classList) {
        for (var i = 0; i < classList.length; i++) {
          var c = classList[i];
          if (c !== 'avatar' && Object.prototype.hasOwnProperty.call(avatars, c)) return c;
        }
        return null;
      },
      byUri: function (uri) {
        if (!uri) return null;
        var clean = uri.replace(/\s+/g, '');
        if (byUri.has(clean)) return byUri.get(clean);
        var key = 'inline-' + (++seq);
        while (avatars[key]) key = 'inline-' + (++seq);
        avatars[key] = clean;
        byUri.set(clean, key);
        return key;
      }
    };
  }

  function resolveAvatar(el, reg) {
    var avEl = el.querySelector('.avatar');
    if (!avEl) {
      var img0 = el.querySelector('img');
      if (img0) return reg.byUri(dataSrc(img0));
      return null;
    }
    var k = reg.byClass(avEl.classList);
    if (k) return k;
    var style = avEl.getAttribute('style') || '';
    var m = style.match(INLINE_BG_RE);
    if (m) return reg.byUri(m[1]);
    var img = avEl.tagName === 'IMG' ? avEl : avEl.querySelector('img');
    if (img) return reg.byUri(dataSrc(img));
    return null;
  }

  function dataSrc(img) {
    var src = img.getAttribute('src') || '';
    return /^data:image\//.test(src) ? src : null;
  }

  function parseArticle(el, reg) {
    var speakerEl = el.querySelector('.speaker');
    var system = el.classList.contains('system') || !speakerEl;
    var m = {
      idx: 0, channelId: '', system: system, avatar: null, speaker: null, color: null,
      time: null, timeText: null, text: '', roll: null, edited: false, channelName: null
    };

    var chEl = el.querySelector('.channel-name');
    if (chEl) {
      var n = stripBrackets(chEl.textContent);
      if (n) m.channelName = n;
    }
    m.channelId = el.getAttribute('data-channel') || m.channelName || '';

    if (speakerEl) {
      m.speaker = speakerEl.textContent.replace(/\s+/g, ' ').trim();
      m.color = extractColor(speakerEl);
    }

    var timeEl = el.querySelector('time, .timestamp');
    if (timeEl) {
      m.time = timeEl.getAttribute('datetime') || null;
      m.timeText = timeEl.textContent.trim() || null;
    }

    var textEl = el.querySelector('.message-text');
    if (textEl) {
      m.text = elementText(textEl);
    } else {
      var clone = el.cloneNode(true);
      var junk = clone.querySelectorAll('.message-header, .avatar, .avatar-spacer, .roll-result, time, .speaker, .channel-name, .edited');
      for (var i = 0; i < junk.length; i++) junk[i].remove();
      m.text = elementText(clone);
    }

    var rollEl = el.querySelector('.roll-result');
    if (rollEl) m.roll = { cls: rollClass(rollEl), text: elementText(rollEl) };

    m.edited = !!el.querySelector('.edited');
    if (!system) m.avatar = resolveAvatar(el, reg);
    return m;
  }

  function parseClassic(p) {
    var spans = directSpans(p);
    var channelName = stripBrackets(spans[0].textContent);
    var speaker = spans[1].textContent.replace(/\s+/g, ' ').trim();
    var parts = [];
    for (var i = 2; i < spans.length; i++) parts.push(elementText(spans[i]));
    // 구형 로그는 각 줄 앞에 공백 하나가 붙어 있으므로 줄 단위로 앞 공백을 제거
    var text = normalizeText(parts.join('\n').split('\n').map(function (l) { return l.replace(/^\s+/, ''); }).join('\n'));
    var system = !speaker || /^system$/i.test(speaker);
    return {
      idx: 0, channelId: channelName || '', system: system, avatar: null,
      speaker: system ? null : speaker, color: system ? null : extractColor(p),
      time: null, timeText: null, text: text, roll: null, edited: false, channelName: channelName || null
    };
  }

  function parse(html, onProgress) {
    return new Promise(function (resolve, reject) {
      var doc;
      try {
        doc = new DOMParser().parseFromString(html, 'text/html');
      } catch (e) {
        reject(new Error('PARSE_FAILED'));
        return;
      }
      var format = detectFormat(doc);
      if (!format) { reject(new Error('NOT_CCFOLIA')); return; }

      var avatars = format === 'new' ? extractAvatarMap(doc) : {};
      var reg = makeAvatarRegistry(avatars);
      var h1 = doc.querySelector('h1');
      var titleRaw = (doc.title && doc.title.trim()) || (h1 && h1.textContent) || '';
      var title = splitTitle(titleRaw);
      var lang = (doc.documentElement.getAttribute('lang') || '').trim().toLowerCase() || 'ko';
      var nodes = format === 'new' ? Array.prototype.slice.call(doc.querySelectorAll('article.message')) : classicNodes(doc);
      if (!nodes.length) { reject(new Error('NOT_CCFOLIA')); return; }

      var messages = [];
      var channels = new Map();
      var i = 0;

      function register(m) {
        var ch = channels.get(m.channelId);
        if (!ch) { ch = { id: m.channelId, name: null, count: 0 }; channels.set(m.channelId, ch); }
        ch.count++;
        if (m.channelName && !ch.name) ch.name = m.channelName;
        delete m.channelName;
      }

      function finish() {
        var chList = Array.from(channels.values());
        var unnamed = chList.filter(function (c) { return !c.name; });
        chList.forEach(function (c, idx) {
          if (c.name) return;
          if (title.tail && unnamed.length === 1) c.name = title.tail;
          else c.name = c.id || ('탭 ' + (idx + 1));
        });

        var usedAvatars = new Set();
        var hasTimestamps = false;
        messages.forEach(function (m) {
          if (m.avatar) usedAvatars.add(m.avatar);
          if (m.time || m.timeText) hasTimestamps = true;
        });

        var warnings = [];
        if (format === 'classic') warnings.push('구형 로그 형식입니다. 아이콘 이미지와 시간 정보가 없어 아이콘 옵션은 적용되지 않습니다.');
        else if (usedAvatars.size === 0) warnings.push('이 파일에는 아이콘 이미지가 없습니다. 아이콘 옵션은 적용되지 않습니다.');
        if (format === 'new' && !hasTimestamps) warnings.push('시간 정보(timestamp)가 없는 파일입니다.');

        resolve({
          format: format,
          title: title.base || titleRaw || 'ccfolia log',
          lang: lang,
          avatars: avatars,
          channels: chList,
          messages: messages,
          warnings: warnings,
          stats: { messages: messages.length, channels: chList.length, avatars: usedAvatars.size, hasTimestamps: hasTimestamps }
        });
      }

      function step() {
        var end = Math.min(i + CHUNK, nodes.length);
        try {
          for (; i < end; i++) {
            var m = format === 'new' ? parseArticle(nodes[i], reg) : parseClassic(nodes[i]);
            m.idx = messages.length;
            messages.push(m);
            register(m);
          }
        } catch (e) {
          reject(e);
          return;
        }
        if (onProgress) onProgress(i, nodes.length);
        if (i < nodes.length) setTimeout(step, 0);
        else finish();
      }
      step();
    });
  }

  /* ---------- JSON 내보내기 형식 ----------
   * { messages: [ { name, color, text, type:'text'|'system', extend:{ roll:{ result, success, failure, critical, fumble } },
   *                edited, channel, channelName, createdAt, updatedAt, iconImage: <hash>|null } ],
   *   images: { <hash>: 'data:image/...;base64,...' } }
   */
  var DEFAULT_CHANNEL_NAMES = { main: '메인', other: '잡담', info: '정보' };

  function looksLikeJson(text) {
    var head = String(text || '').slice(0, 64).replace(/^﻿/, '').trim();
    return head.charAt(0) === '{' || head.charAt(0) === '[';
  }

  function rollClassFromFlags(r) {
    if (!r) return '';
    if (r.critical) return 'critical';
    if (r.fumble) return 'fumble';
    if (r.success) return 'success';
    if (r.failure) return 'failure';
    return '';
  }

  function parseJsonMessage(raw, images) {
    var m = {
      idx: 0, channelId: '', system: false, avatar: null, speaker: null, color: null,
      time: null, timeText: null, text: '', roll: null, edited: false, channelName: null
    };
    var name = raw.name == null ? '' : String(raw.name).replace(/\s+/g, ' ').trim();
    m.system = raw.type === 'system' || !name;
    m.channelId = raw.channel != null ? String(raw.channel) : (raw.channelName != null ? String(raw.channelName) : '');
    var chName = raw.channelName != null ? String(raw.channelName).trim() : '';
    if (chName && chName !== m.channelId) m.channelName = chName;
    else if (DEFAULT_CHANNEL_NAMES[m.channelId]) m.channelName = DEFAULT_CHANNEL_NAMES[m.channelId];
    else if (chName) m.channelName = chName;
    if (!m.system) {
      m.speaker = name;
      m.color = sanitizeColor(raw.color);
      var icon = raw.iconImage;
      if (icon && images && Object.prototype.hasOwnProperty.call(images, icon)) m.avatar = String(icon);
    }
    if (raw.createdAt != null && isFinite(raw.createdAt)) {
      var d = new Date(Number(raw.createdAt));
      if (!isNaN(d.getTime())) { m.time = d.toISOString(); m.timeText = d.toLocaleString(); }
    }
    m.text = normalizeText(raw.text == null ? '' : String(raw.text));
    var roll = raw.extend && raw.extend.roll;
    if (roll && roll.result != null) m.roll = { cls: rollClassFromFlags(roll), text: normalizeText(String(roll.result)) };
    m.edited = !!raw.edited;
    return m;
  }

  function parseJson(text, options, onProgress) {
    var opts = options || {};
    return new Promise(function (resolve, reject) {
      var root;
      try { root = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { reject(new Error('PARSE_FAILED')); return; }
      var list = Array.isArray(root) ? root : (root && Array.isArray(root.messages) ? root.messages : null);
      if (!list || !list.length) { reject(new Error('NOT_CCFOLIA')); return; }
      var sample = list[0];
      if (!sample || typeof sample !== 'object' || !('text' in sample && ('channel' in sample || 'channelName' in sample || 'name' in sample))) {
        reject(new Error('NOT_CCFOLIA')); return;
      }
      var images = {};
      var rawImages = (root && root.images && typeof root.images === 'object') ? root.images : {};
      Object.keys(rawImages).forEach(function (k) {
        var v = rawImages[k];
        if (typeof v === 'string' && /^data:image\//.test(v)) images[k] = v.replace(/\s+/g, '');
      });

      var messages = [];
      var channels = new Map();
      var i = 0;

      function register(m) {
        var ch = channels.get(m.channelId);
        if (!ch) { ch = { id: m.channelId, name: null, count: 0 }; channels.set(m.channelId, ch); }
        ch.count++;
        if (m.channelName && !ch.name) ch.name = m.channelName;
        delete m.channelName;
      }

      function finish() {
        var chList = Array.from(channels.values());
        chList.forEach(function (c, idx) { if (!c.name) c.name = c.id || ('탭 ' + (idx + 1)); });
        var usedAvatars = new Set();
        var hasTimestamps = false;
        messages.forEach(function (m) {
          if (m.avatar) usedAvatars.add(m.avatar);
          if (m.time) hasTimestamps = true;
        });
        var warnings = [];
        if (usedAvatars.size === 0) warnings.push('이 파일에는 아이콘 이미지가 없습니다. 아이콘 옵션은 적용되지 않습니다.');
        resolve({
          format: 'json',
          title: (opts.title || '').trim() || 'ccfolia log',
          lang: 'ko',
          avatars: images,
          channels: chList,
          messages: messages,
          warnings: warnings,
          stats: { messages: messages.length, channels: chList.length, avatars: usedAvatars.size, hasTimestamps: hasTimestamps }
        });
      }

      function step() {
        var end = Math.min(i + CHUNK, list.length);
        try {
          for (; i < end; i++) {
            var raw = list[i];
            if (!raw || typeof raw !== 'object') continue;
            var m = parseJsonMessage(raw, images);
            m.idx = messages.length;
            messages.push(m);
            register(m);
          }
        } catch (e) {
          reject(e);
          return;
        }
        if (onProgress) onProgress(i, list.length);
        if (i < list.length) setTimeout(step, 0);
        else finish();
      }
      step();
    });
  }

  global.CcfoliaParser = { parse: parse, parseJson: parseJson, looksLikeJson: looksLikeJson, stripBrackets: stripBrackets, splitTitle: splitTitle };
})(window);
