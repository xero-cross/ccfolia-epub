/* epub.js — 렌더 블록 → EPUB 3 (JSZip)
 *
 * 구조
 *  mimetype (STORE, 첫 항목)
 *  META-INF/container.xml
 *  OEBPS/content.opf, nav.xhtml, toc.ncx, style.css
 *  OEBPS/text/part-NNNN.xhtml  (독자에게 보이지 않는 내부 분할)
 *  OEBPS/images/av-N.ext       (사용된 아바타만)
 */
(function (global) {
  'use strict';

  var XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  var PART_LIMIT_CHARS = 100000; // 한글 기준 약 250~300KB
  var MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(XML_BAD, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function textHtml(s) {
    return esc(s).replace(/\n/g, '<br/>');
  }

  function safeColor(c) {
    if (!c) return null;
    var s = String(c).trim();
    return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/.test(s) ? s : null;
  }

  function parseDataUri(uri) {
    var m = /^data:(image\/[A-Za-z0-9.+\-]+);base64,([\s\S]+)$/.exec(uri || '');
    if (!m) return null;
    var mime = m[1].toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!MIME_EXT[mime]) return null;
    return { mime: mime, ext: MIME_EXT[mime], b64: m[2].replace(/\s+/g, '') };
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function safeFilename(name) {
    var s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\.+/, '').slice(0, 120);
    return s || 'ccfolia-log';
  }

  var EPUB_CSS = [
    'body { font-family: serif; line-height: 1.6; margin: 0; padding: 0 0.5em; }',
    'h1.book-title { font-size: 1.4em; margin: 1em 0 1.2em; text-align: center; }',
    'h2.tab-heading { font-size: 1.15em; margin: 1.6em 0 0.8em; padding-bottom: 0.2em; border-bottom: 1px solid #999; }',
    '.msg { margin: 0 0 0.9em; }',
    '.msg .avatar { float: left; width: 40px; height: 40px; margin: 0.15em 0.55em 0.2em 0; }',
    '.msg .body { overflow: hidden; }',
    '.clr { clear: both; height: 0; line-height: 0; font-size: 0; }',
    'p.speaker { font-weight: bold; margin: 0 0 0.15em; font-size: 0.95em; }',
    '.tab { color: #888; font-weight: normal; font-size: 0.8em; margin-left: 0.4em; }',
    'p.text { margin: 0 0 0.3em; }',
    'p.roll { color: #666; font-size: 0.9em; margin: 0 0 0.3em; }',
    'p.roll.success, p.roll.critical { color: #1565c0; }',
    'p.roll.failure, p.roll.fumble { color: #c62828; }',
    'p.system { color: #777; font-size: 0.85em; text-align: center; margin: 0.7em 0; }',
    'p.empty { color: #777; text-align: center; margin: 2em 0; }',
    '/* 보조 스타일 탭 (작게·회색) */',
    '.msg.muted p.speaker { opacity: 0.8; font-size: 0.85em; }',
    '.msg.muted p.text { font-size: 0.85em; color: #777; }',
    '.msg.muted p.roll { font-size: 0.8em; }',
    'p.system.muted { font-size: 0.78em; }',
    'body.cover-page { margin: 0; padding: 0; text-align: center; }',
    '.cover-wrap { margin: 0; padding: 0; text-align: center; }',
    '.cover-wrap img { max-width: 100%; max-height: 100%; }'
  ].join('\n');

  function renderBlock(b, images) {
    if (b.type === 'tabHeading') {
      return '<h2 class="tab-heading">' + esc(b.name) + '</h2>';
    }
    if (b.type === 'system') {
      return '<p class="system' + (b.muted ? ' muted' : '') + '">' + textHtml(b.text) + '</p>';
    }
    var img = b.avatar ? images.get(b.avatar) : null;
    var color = safeColor(b.color);
    var out = '<div class="msg' + (b.muted ? ' muted' : '') + '">';
    if (img) out += '<img class="avatar" src="../' + img.href + '" alt=""/>';
    out += '<div class="body">';
    out += '<p class="speaker"' + (color ? ' style="color:' + esc(color) + '"' : '') + '>' + esc(b.speaker || '') + '</p>';
    for (var i = 0; i < b.items.length; i++) {
      var it = b.items[i];
      if (it.text) out += '<p class="text">' + textHtml(it.text) + '</p>';
      if (it.roll && it.roll.text) out += '<p class="roll ' + esc(it.roll.cls || '') + '">' + textHtml(it.roll.text) + '</p>';
    }
    out += '</div><div class="clr"></div></div>';
    return out;
  }

  function partXhtml(title, lang, body, isFirst) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' + esc(lang) + '" lang="' + esc(lang) + '">\n' +
      '<head>\n<meta charset="utf-8"/>\n<title>' + esc(title) + '</title>\n' +
      '<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head>\n<body>\n' +
      (isFirst ? '<h1 class="book-title">' + esc(title) + '</h1>\n' : '') +
      body + '\n</body>\n</html>\n';
  }

  function coverXhtml(title, lang, imgHref) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' + esc(lang) + '" lang="' + esc(lang) + '">\n' +
      '<head>\n<meta charset="utf-8"/>\n<title>' + esc(title) + '</title>\n' +
      '<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head>\n' +
      '<body class="cover-page" epub:type="cover">\n<div class="cover-wrap"><img src="../' + esc(imgHref) + '" alt="' + esc(title) + '"/></div>\n</body>\n</html>\n';
  }

  function containerXml() {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n' +
      '</container>\n';
  }

  function navXhtml(title, lang, firstHref) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' + esc(lang) + '" lang="' + esc(lang) + '">\n' +
      '<head>\n<meta charset="utf-8"/>\n<title>' + esc(title) + '</title>\n</head>\n<body>\n' +
      '<nav epub:type="toc" id="toc">\n<h1>' + esc(title) + '</h1>\n<ol>\n<li><a href="' + esc(firstHref) + '">' + esc(title) + '</a></li>\n</ol>\n</nav>\n' +
      '</body>\n</html>\n';
  }

  function tocNcx(title, uid, firstHref) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '<head>\n<meta name="dtb:uid" content="' + esc(uid) + '"/>\n<meta name="dtb:depth" content="1"/>\n' +
      '<meta name="dtb:totalPageCount" content="0"/>\n<meta name="dtb:maxPageNumber" content="0"/>\n</head>\n' +
      '<docTitle><text>' + esc(title) + '</text></docTitle>\n' +
      '<navMap>\n<navPoint id="np1" playOrder="1"><navLabel><text>' + esc(title) + '</text></navLabel><content src="' + esc(firstHref) + '"/></navPoint>\n</navMap>\n' +
      '</ncx>\n';
  }

  function contentOpf(meta, parts, images, cover) {
    var manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      '<item id="css" href="style.css" media-type="text/css"/>'
    ];
    var spine = [];
    if (cover) {
      manifest.push('<item id="cover-image" href="' + esc(cover.imgHref) + '" media-type="' + esc(cover.mime) + '" properties="cover-image"/>');
      manifest.push('<item id="cover" href="' + esc(cover.pageHref) + '" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="cover" linear="yes"/>');
    }
    parts.forEach(function (p) {
      manifest.push('<item id="' + p.id + '" href="' + esc(p.href) + '" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="' + p.id + '"/>');
    });
    images.forEach(function (img) {
      manifest.push('<item id="' + img.id + '" href="' + esc(img.href) + '" media-type="' + esc(img.mime) + '"/>');
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="' + esc(meta.lang) + '">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '<dc:identifier id="bookid">' + esc(meta.uid) + '</dc:identifier>\n' +
      '<dc:title>' + esc(meta.title) + '</dc:title>\n' +
      '<dc:language>' + esc(meta.lang) + '</dc:language>\n' +
      (meta.author ? '<dc:creator>' + esc(meta.author) + '</dc:creator>\n' : '') +
      '<meta property="dcterms:modified">' + esc(meta.modified) + '</meta>\n' +
      (cover ? '<meta name="cover" content="cover-image"/>\n' : '') +
      '</metadata>\n' +
      '<manifest>\n' + manifest.join('\n') + '\n</manifest>\n' +
      '<spine toc="ncx">\n' + spine.join('\n') + '\n</spine>\n' +
      '</package>\n';
  }

  // 아이콘은 본문에서 40px로만 쓰이므로 큰 원본(JSON 내보내기 등)은 축소해서 넣는다
  var AVATAR_MAX = 160;

  function shrinkAvatar(uri, parsed) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h || (w <= AVATAR_MAX && h <= AVATAR_MAX)) { resolve(parsed); return; }
        try {
          var scale = AVATAR_MAX / Math.max(w, h);
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          var out = c.toDataURL('image/png');
          resolve({ mime: 'image/png', ext: 'png', b64: out.split(',')[1] });
        } catch (e) {
          resolve(parsed);
        }
      };
      img.onerror = function () { resolve(parsed); };
      img.src = uri;
    });
  }

  function build(blocks, data, opts, onProgress) {
    if (typeof global.JSZip === 'undefined') {
      return Promise.reject(new Error('JSZIP_MISSING'));
    }
    return prepareImages(blocks, data, opts).then(function (images) {
      return buildWithImages(blocks, data, opts, images, onProgress);
    });
  }

  function prepareImages(blocks, data, opts) {
    var images = new Map();
    if (!opts.showAvatar) return Promise.resolve(images);
    var keys = [];
    blocks.forEach(function (b) {
      if (b.type === 'group' && b.avatar && keys.indexOf(b.avatar) === -1) keys.push(b.avatar);
    });
    var n = 0;
    return keys.reduce(function (p, key) {
      return p.then(function () {
        var uri = data.avatars[key];
        var parsed = parseDataUri(uri);
        if (!parsed) return;
        var shrink = parsed.mime === 'image/svg+xml' ? Promise.resolve(parsed) : shrinkAvatar(uri, parsed);
        return shrink.then(function (final) {
          n++;
          images.set(key, { id: 'img' + n, href: 'images/av-' + n + '.' + final.ext, mime: final.mime, b64: final.b64 });
        });
      });
    }, Promise.resolve()).then(function () { return images; });
  }

  function buildWithImages(blocks, data, opts, images, onProgress) {
    var title = String(opts.bookTitle || data.title || '').trim() || 'ccfolia log';
    var author = String(opts.author || '').trim();
    var lang = /^[a-z]{2}(-[A-Za-z0-9]+)*$/.test(data.lang || '') ? data.lang : 'ko';

    // 본문 직렬화 + 내부 분할
    var partBodies = [];
    var cur = [];
    var curLen = 0;
    function flush() {
      if (cur.length) { partBodies.push(cur.join('\n')); cur = []; curLen = 0; }
    }
    blocks.forEach(function (b) {
      var html = renderBlock(b, images);
      if (curLen + html.length > PART_LIMIT_CHARS && cur.length) flush();
      cur.push(html);
      curLen += html.length;
    });
    flush();
    if (!partBodies.length) partBodies.push('<p class="empty">(포함된 메시지가 없습니다)</p>');

    var parts = partBodies.map(function (body, i) {
      return { id: 'part' + (i + 1), href: 'text/part-' + pad(i + 1, 4) + '.xhtml', body: body };
    });

    var meta = {
      title: title, author: author, lang: lang,
      uid: 'urn:uuid:' + uuid(),
      modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    };

    var cover = null;
    if (opts.cover && opts.cover.b64) {
      var cmime = opts.cover.mime === 'image/png' ? 'image/png' : 'image/jpeg';
      cover = { imgHref: 'images/cover.' + (cmime === 'image/png' ? 'png' : 'jpg'), pageHref: 'text/cover.xhtml', mime: cmime, b64: opts.cover.b64 };
    }

    var zip = new global.JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', containerXml());
    zip.file('OEBPS/content.opf', contentOpf(meta, parts, images, cover));
    if (cover) {
      zip.file('OEBPS/' + cover.pageHref, coverXhtml(title, lang, cover.imgHref));
      zip.file('OEBPS/' + cover.imgHref, cover.b64, { base64: true });
    }
    zip.file('OEBPS/nav.xhtml', navXhtml(title, lang, parts[0].href));
    zip.file('OEBPS/toc.ncx', tocNcx(title, meta.uid, parts[0].href));
    zip.file('OEBPS/style.css', EPUB_CSS);
    parts.forEach(function (p, i) {
      zip.file('OEBPS/' + p.href, partXhtml(title, lang, p.body, i === 0));
    });
    images.forEach(function (img) {
      zip.file('OEBPS/' + img.href, img.b64, { base64: true });
    });

    return zip.generateAsync(
      { type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      function (m) { if (onProgress) onProgress(m.percent); }
    ).then(function (blob) {
      return { blob: blob, filename: safeFilename(title) + '.epub', parts: parts.length, images: images.size, cover: !!cover };
    });
  }

  global.CcfoliaEpub = { build: build, safeFilename: safeFilename };
})(window);
