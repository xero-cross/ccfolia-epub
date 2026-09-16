/* cover.js — 표지 이미지 생성 (1600×2560, JPEG)
 *
 * CcfoliaCover.make({ file, title, author, fit }) → Promise<{ b64, mime, dataUrl }>
 *  - file: File|null. 없으면 제목 텍스트로 자동 생성
 *  - fit: 'cover'(채우기, 가장자리 잘라냄) | 'contain'(맞추기, 여백 채움)
 */
(function (global) {
  'use strict';

  var W = 1600;
  var H = 2560;
  var QUALITY = 0.9;

  function loadImage(file) {
    if (global.createImageBitmap) {
      return global.createImageBitmap(file).catch(function () { return loadViaElement(file); });
    }
    return loadViaElement(file);
  }

  function loadViaElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('IMAGE_LOAD_FAILED')); };
      img.src = url;
    });
  }

  function dims(img) {
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  }

  // 가장자리 픽셀 평균색 (맞추기 모드의 여백 색)
  function edgeColor(img) {
    var c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 32, 32);
    var d = ctx.getImageData(0, 0, 32, 32).data;
    var r = 0, g = 0, b = 0, n = 0;
    for (var y = 0; y < 32; y++) {
      for (var x = 0; x < 32; x++) {
        if (x > 0 && x < 31 && y > 0 && y < 31) continue;
        var i = (y * 32 + x) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
    return 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')';
  }

  function drawImageCover(ctx, img, fit) {
    var s = dims(img);
    if (fit === 'contain') {
      ctx.fillStyle = edgeColor(img);
      ctx.fillRect(0, 0, W, H);
      var scale = Math.min(W / s.w, H / s.h);
      var dw = s.w * scale, dh = s.h * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      var sc = Math.max(W / s.w, H / s.h);
      var cw = s.w * sc, ch = s.h * sc;
      ctx.drawImage(img, (W - cw) / 2, (H - ch) / 2, cw, ch);
    }
  }

  function wrapLines(ctx, text, maxWidth, maxLines) {
    var lines = [];
    var paragraphs = String(text || '').split(/\n/);
    for (var p = 0; p < paragraphs.length; p++) {
      var words = paragraphs[p].split(/(\s+)/);
      var line = '';
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (!w) continue;
        var test = line + w;
        if (ctx.measureText(test).width <= maxWidth || !line) {
          // 한 단어가 폭을 넘으면 글자 단위로 자른다
          if (ctx.measureText(test).width > maxWidth) {
            var chars = w.split('');
            var cur = line;
            for (var c = 0; c < chars.length; c++) {
              if (ctx.measureText(cur + chars[c]).width > maxWidth && cur) { lines.push(cur.trim()); cur = ''; }
              cur += chars[c];
            }
            line = cur;
          } else {
            line = test;
          }
        } else {
          lines.push(line.trim());
          line = w.trim() ? w : '';
        }
      }
      if (line.trim()) lines.push(line.trim());
    }
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '') + '…';
    }
    return lines;
  }

  function drawAutoCover(ctx, title, author) {
    var grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0b3d3a');
    grad.addColorStop(0.55, '#134e4a');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 장식 원
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#5eead4';
    ctx.beginPath(); ctx.arc(W * 0.85, H * 0.18, 420, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.12, H * 0.86, 520, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    // 테두리 선
    ctx.strokeStyle = 'rgba(94,234,212,0.6)';
    ctx.lineWidth = 6;
    ctx.strokeRect(110, 110, W - 220, H - 220);

    var fontFamily = '"Pretendard","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif';
    var fontSize = 128;
    var lines;
    do {
      ctx.font = '700 ' + fontSize + 'px ' + fontFamily;
      lines = wrapLines(ctx, title, W - 360, 6);
      fontSize -= 8;
    } while (lines.length > 4 && fontSize > 72);

    ctx.fillStyle = '#f0fdfa';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var lineH = fontSize * 1.25 + 10;
    var startY = H * 0.46 - (lines.length - 1) * lineH / 2;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], W / 2, startY + i * lineH);
    ctx.shadowColor = 'transparent';

    // 구분선
    ctx.fillStyle = '#5eead4';
    ctx.fillRect(W / 2 - 120, startY + lines.length * lineH + 20, 240, 8);

    if (author) {
      ctx.font = '500 64px ' + fontFamily;
      ctx.fillStyle = 'rgba(240,253,250,0.85)';
      var aLines = wrapLines(ctx, author, W - 400, 2);
      for (var j = 0; j < aLines.length; j++) ctx.fillText(aLines[j], W / 2, startY + lines.length * lineH + 130 + j * 84);
    }

    ctx.font = '500 44px ' + fontFamily;
    ctx.fillStyle = 'rgba(240,253,250,0.55)';
    ctx.fillText('TRPG SESSION LOG', W / 2, H - 260);
  }

  function make(o) {
    var opts = o || {};
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var p = opts.file
      ? loadImage(opts.file).then(function (img) { drawImageCover(ctx, img, opts.fit || 'cover'); })
      : Promise.resolve().then(function () { drawAutoCover(ctx, opts.title || 'ccfolia log', opts.author || ''); });
    return p.then(function () {
      var dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
      return { mime: 'image/jpeg', b64: dataUrl.split(',')[1], dataUrl: dataUrl, width: W, height: H };
    });
  }

  global.CcfoliaCover = { make: make, WIDTH: W, HEIGHT: H };
})(window);
