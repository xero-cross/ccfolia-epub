/* app.js — 상태 관리, UI 이벤트, 미리보기, 표지, 다운로드 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ccfolia-epub-opts-v1';
  var PREVIEW_BATCH = 200;
  var DEFAULT_OPTS = { showAvatar: true, merge: false, mergeSplitOnAvatarChange: false, groupByTab: false, author: '', coverFit: 'cover', coverPosX: 50 };
  // 코코포리아 기본 탭 id 중 "잡담(other)"은 처음부터 보조 스타일로 둔다
  var DEFAULT_MUTED_IDS = ['other'];

  var $ = function (sel) { return document.querySelector(sel); };
  var els = {
    fileInput: $('#file-input'),
    dropZone: $('#drop-zone'),
    status: $('#status'),
    fileInfo: $('#file-info'),
    fileChip: $('#file-chip'),
    warnings: $('#warnings'),
    bookTitle: $('#book-title'),
    bookAuthor: $('#book-author'),
    coverInput: $('#cover-input'),
    coverThumb: $('#cover-thumb'),
    coverRemove: $('#cover-remove'),
    coverFitGroup: $('#cover-fit-group'),
    coverPosGroup: $('#cover-pos-group'),
    coverPosX: $('#cover-pos-x'),
    optAvatar: $('#opt-avatar'),
    optMerge: $('#opt-merge'),
    optMergeSplit: $('#opt-merge-split'),
    mergeSub: $('#merge-sub'),
    optTabs: $('#opt-tabs'),
    channelList: $('#channel-list'),
    chAll: $('#ch-all'),
    chNone: $('#ch-none'),
    btnDownload: $('#btn-download'),
    dlProgress: $('#dl-progress'),
    dlStatus: $('#dl-status'),
    summaryTitle: $('#summary-title'),
    summaryCount: $('#summary-count'),
    previewScroll: $('#preview-scroll'),
    previewEmpty: $('#preview-empty'),
    previewList: $('#preview-list'),
    sentinel: $('#sentinel'),
    btnEmptyUpload: $('#btn-empty-upload'),
    needsFile: document.querySelectorAll('.card.needs-file')
  };

  var state = {
    data: null,
    fileName: '',
    opts: loadOpts(),
    enabled: new Set(),
    muted: new Set(),
    bookTitle: '',
    coverFile: null,
    coverThumbUrl: null,
    blocks: [],
    stats: null,
    renderIndex: 0,
    busy: false
  };

  var avatarStyleEl = null;
  var observer = null;

  /* ---------- 옵션 저장/복원 ---------- */
  function loadOpts() {
    var opts = Object.assign({}, DEFAULT_OPTS);
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(DEFAULT_OPTS).forEach(function (k) {
          if (typeof saved[k] === typeof DEFAULT_OPTS[k]) opts[k] = saved[k];
        });
      }
    } catch (e) { /* ignore */ }
    if (opts.coverFit !== 'cover' && opts.coverFit !== 'contain') opts.coverFit = 'cover';
    if (!isFinite(opts.coverPosX)) opts.coverPosX = 50;
    opts.coverPosX = Math.min(100, Math.max(0, Math.round(opts.coverPosX)));
    return opts;
  }

  function saveOpts() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.opts)); } catch (e) { /* ignore */ }
  }

  /* ---------- 유틸 ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmt(n) { return Number(n).toLocaleString('ko-KR'); }

  function setStatus(msg, isError) {
    els.status.hidden = !msg;
    els.status.textContent = msg || '';
    els.status.classList.toggle('is-error', !!isError);
  }

  function setDlStatus(msg, isError) {
    els.dlStatus.hidden = !msg;
    els.dlStatus.textContent = msg || '';
    els.dlStatus.classList.toggle('is-error', !!isError);
  }

  function setPanelsEnabled(on) {
    Array.prototype.forEach.call(els.needsFile, function (p) { p.classList.toggle('is-disabled', !on); });
    els.btnDownload.disabled = !on || state.busy;
  }

  /* ---------- 파일 읽기 ---------- */
  function readFileText(file) {
    return file.arrayBuffer().then(function (buf) {
      var head = '';
      try { head = new TextDecoder('latin1').decode(buf.slice(0, 4096)); } catch (e) { /* ignore */ }
      var m = head.match(/charset\s*=\s*["']?\s*([A-Za-z0-9_\-]+)/i);
      var enc = m ? m[1].toLowerCase() : 'utf-8';
      try {
        return new TextDecoder(enc, { fatal: false }).decode(buf);
      } catch (e) {
        return new TextDecoder('utf-8').decode(buf);
      }
    });
  }

  // "룸이름_log.json" → "룸이름"
  function titleFromFilename(name) {
    return String(name || '')
      .replace(/\.(json|html?)$/i, '')
      .replace(/[_\-\s]*log$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function handleFile(file) {
    if (!file) return;
    if (state.busy) return;
    state.busy = true;
    setPanelsEnabled(false);
    els.fileInfo.hidden = true;
    els.warnings.hidden = true;
    setDlStatus('');
    setStatus('파일을 읽는 중…');

    readFileText(file).then(function (text) {
      setStatus('로그를 분석하는 중…');
      var progress = function (done, total) {
        setStatus('로그를 분석하는 중… ' + fmt(done) + ' / ' + fmt(total));
      };
      var isJson = /\.json$/i.test(file.name) || window.CcfoliaParser.looksLikeJson(text);
      if (isJson) {
        return window.CcfoliaParser.parseJson(text, { title: titleFromFilename(file.name) }, progress);
      }
      return window.CcfoliaParser.parse(text, progress);
    }).then(function (data) {
      state.busy = false;
      applyData(data, file.name);
    }).catch(function (err) {
      state.busy = false;
      var msg = (err && err.message) || String(err);
      if (msg === 'NOT_CCFOLIA') msg = '코코포리아 로그 형식을 찾지 못했습니다. 코코포리아 룸에서 내보낸 HTML 또는 JSON 로그 파일을 올려 주세요.';
      else if (msg === 'PARSE_FAILED') msg = '파일을 해석하지 못했습니다. HTML 또는 JSON 형식이 맞는지 확인해 주세요.';
      else msg = '분석 중 오류가 발생했습니다: ' + msg;
      setStatus(msg, true);
      setPanelsEnabled(!!state.data);
      if (state.data) {
        els.fileInfo.hidden = false;
        els.warnings.hidden = !state.data.warnings.length;
      }
      console.error(err);
    });
  }

  /* ---------- 데이터 적용 ---------- */
  function applyData(data, fileName) {
    state.data = data;
    state.fileName = fileName;
    state.bookTitle = data.title;
    state.enabled = new Set(data.channels.map(function (c) { return c.id; }));
    state.muted = new Set(data.channels
      .filter(function (c) { return DEFAULT_MUTED_IDS.indexOf(c.id) !== -1; })
      .map(function (c) { return c.id; }));

    setStatus('');
    els.fileInfo.hidden = false;
    els.fileInfo.innerHTML = '';
    els.fileInfo.append(el('div', 'name', fileName));
    els.fileInfo.append(el('div', 'meta',
      (data.format === 'classic' ? '구형 HTML' : data.format === 'json' ? 'JSON 형식' : '신형 HTML') +
      ' · 메시지 ' + fmt(data.stats.messages) + '개 · 탭 ' + fmt(data.stats.channels) + '개 · 아이콘 ' + fmt(data.stats.avatars) + '종'));
    els.fileChip.hidden = false;
    els.fileChip.textContent = fileName;
    els.fileChip.title = fileName;

    els.warnings.innerHTML = '';
    els.warnings.hidden = !data.warnings.length;
    data.warnings.forEach(function (w) { els.warnings.append(el('li', null, w)); });

    els.bookTitle.value = state.bookTitle;
    els.bookAuthor.value = state.opts.author;

    installAvatarStyles(data.avatars);
    renderChannelList();
    syncOptionUI();
    setPanelsEnabled(true);
    els.previewEmpty.hidden = true;
    recompute();
  }

  function installAvatarStyles(avatars) {
    if (avatarStyleEl) avatarStyleEl.remove();
    avatarStyleEl = document.createElement('style');
    var rules = [];
    Object.keys(avatars).forEach(function (key) {
      rules.push('.pv-avatar[data-av="' + key.replace(/"/g, '') + '"]{background-image:url("' + avatars[key] + '")}');
    });
    avatarStyleEl.textContent = rules.join('\n');
    document.head.append(avatarStyleEl);
  }

  function renderChannelList() {
    els.channelList.innerHTML = '';
    var chs = state.data ? state.data.channels : [];
    if (!chs.length) {
      els.channelList.append(el('div', 'channel-empty', '탭 정보가 없습니다.'));
      return;
    }
    chs.forEach(function (c) {
      var label = el('label', 'channel-item');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.enabled.has(c.id);
      cb.addEventListener('change', function () {
        if (cb.checked) state.enabled.add(c.id); else state.enabled.delete(c.id);
        label.classList.toggle('is-off', !cb.checked);
        recompute();
      });
      label.classList.toggle('is-off', !cb.checked);

      var mute = el('button', 'ch-mute', 'Aa');
      mute.type = 'button';
      mute.title = '이 탭의 글씨를 작고 회색으로 표시';
      mute.setAttribute('aria-pressed', state.muted.has(c.id) ? 'true' : 'false');
      mute.classList.toggle('is-on', state.muted.has(c.id));
      mute.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (state.muted.has(c.id)) state.muted.delete(c.id); else state.muted.add(c.id);
        var on = state.muted.has(c.id);
        mute.classList.toggle('is-on', on);
        mute.setAttribute('aria-pressed', on ? 'true' : 'false');
        recompute();
      });

      label.append(cb, el('span', 'ch-name', c.name), el('span', 'ch-count', fmt(c.count) + '개'), mute);
      els.channelList.append(label);
    });
  }

  function setAllChannels(on) {
    if (!state.data) return;
    state.enabled = new Set(on ? state.data.channels.map(function (c) { return c.id; }) : []);
    renderChannelList();
    recompute();
  }

  function syncOptionUI() {
    var hasAvatars = !!(state.data && state.data.stats.avatars > 0);
    els.optAvatar.checked = state.opts.showAvatar;
    els.optAvatar.closest('.toggle-row').classList.toggle('is-disabled', !hasAvatars);
    els.optMerge.checked = state.opts.merge;
    els.optMergeSplit.checked = state.opts.mergeSplitOnAvatarChange;
    els.mergeSub.classList.toggle('is-hidden', !state.opts.merge);
    els.mergeSub.classList.toggle('is-disabled', !hasAvatars || !state.opts.showAvatar);
    els.optTabs.checked = state.opts.groupByTab;
    var fitRadio = els.coverFitGroup.querySelector('input[value="' + state.opts.coverFit + '"]');
    if (fitRadio) fitRadio.checked = true;
    els.coverPosX.value = String(state.opts.coverPosX);
    els.coverFitGroup.classList.toggle('is-hidden', !state.coverFile);
    els.coverPosGroup.classList.toggle('is-hidden', !state.coverFile);
  }

  function effectiveOpts() {
    var hasAvatars = !!(state.data && state.data.stats.avatars > 0);
    return {
      showAvatar: state.opts.showAvatar && hasAvatars,
      merge: state.opts.merge,
      mergeSplitOnAvatarChange: state.opts.mergeSplitOnAvatarChange,
      groupByTab: state.opts.groupByTab,
      enabledChannels: state.enabled,
      mutedChannels: state.muted,
      bookTitle: state.bookTitle,
      author: state.opts.author
    };
  }

  /* ---------- 표지 ---------- */
  function setCoverFile(file) {
    if (state.coverThumbUrl) { URL.revokeObjectURL(state.coverThumbUrl); state.coverThumbUrl = null; }
    state.coverFile = file || null;
    if (file) {
      state.coverThumbUrl = URL.createObjectURL(file);
      els.coverThumb.style.backgroundImage = 'url("' + state.coverThumbUrl + '")';
      els.coverThumb.classList.add('has-image');
      els.coverThumb.title = file.name;
    } else {
      els.coverThumb.style.backgroundImage = '';
      els.coverThumb.classList.remove('has-image');
      els.coverThumb.title = '';
    }
    els.coverRemove.hidden = !file;
    els.coverFitGroup.classList.toggle('is-hidden', !file);
    els.coverPosGroup.classList.toggle('is-hidden', !file);
    updateCoverThumbFit();
  }

  function updateCoverThumbFit() {
    els.coverThumb.style.backgroundSize = state.opts.coverFit === 'contain' ? 'contain' : 'cover';
    els.coverThumb.style.backgroundPosition = state.opts.coverPosX + '% center';
  }

  /* ---------- 미리보기 ---------- */
  function recompute() {
    if (!state.data) return;
    var result = window.CcfoliaLayout.buildBlocks(state.data, effectiveOpts());
    state.blocks = result.blocks;
    state.stats = result.stats;
    updateSummary();
    els.previewList.innerHTML = '';
    state.renderIndex = 0;
    els.previewScroll.scrollTop = 0;
    renderMore();
  }

  function updateSummary() {
    els.summaryTitle.textContent = state.bookTitle || '미리보기';
    var s = state.stats;
    if (!s) { els.summaryCount.textContent = ''; return; }
    var txt = '메시지 ' + fmt(s.included) + '개';
    if (s.excluded) txt += ' · 제외 ' + fmt(s.excluded) + '개';
    if (state.opts.merge) txt += ' · 덩어리 ' + fmt(s.groups) + '개';
    els.summaryCount.textContent = txt;
  }

  function renderMore() {
    var end = Math.min(state.renderIndex + PREVIEW_BATCH, state.blocks.length);
    var frag = document.createDocumentFragment();
    var opts = effectiveOpts();
    for (var i = state.renderIndex; i < end; i++) frag.append(renderBlockEl(state.blocks[i], opts));
    els.previewList.append(frag);
    state.renderIndex = end;
    var more = state.renderIndex < state.blocks.length;
    els.sentinel.hidden = !more;
    if (!state.blocks.length) {
      els.previewList.append(el('div', 'pv-system', '포함된 메시지가 없습니다. 탭을 하나 이상 선택해 주세요.'));
    }
  }

  function chip(text) { return el('span', 'pv-chip', text); }

  function renderBlockEl(b, opts) {
    if (b.type === 'tabHeading') {
      var h = el('h2', 'pv-tab', b.name);
      h.append(chip(fmt(b.count) + '개'));
      return h;
    }
    if (b.type === 'system') {
      var s = el('div', 'pv-system' + (b.muted ? ' is-muted' : ''));
      s.append(document.createTextNode(b.text));
      return s;
    }
    var wrap = el('div', 'pv-msg' + (b.muted ? ' is-muted' : ''));
    var uri = opts.showAvatar && b.avatar ? state.data.avatars[b.avatar] : null;
    if (uri) {
      var av = el('span', 'pv-avatar');
      av.setAttribute('data-av', b.avatar);
      wrap.append(av);
    } else {
      wrap.classList.add('no-avatar');
    }
    var body = el('div', 'pv-body');
    var name = el('div', 'pv-speaker');
    var nameText = el('span', null, b.speaker || '');
    if (b.color) nameText.style.color = b.color;
    name.append(nameText);
    if (b.items.length > 1) name.append(chip(b.items.length + '개 통합'));
    body.append(name);
    b.items.forEach(function (it) {
      if (it.text) body.append(el('div', 'pv-text', it.text));
      if (it.roll && it.roll.text) body.append(el('div', 'pv-roll ' + (it.roll.cls || ''), it.roll.text));
    });
    wrap.append(body);
    return wrap;
  }

  function setupObserver() {
    if (!('IntersectionObserver' in window)) {
      els.previewScroll.addEventListener('scroll', function () {
        var sc = els.previewScroll;
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 400) renderMore();
      });
      return;
    }
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting && !els.sentinel.hidden) renderMore(); });
    }, { root: null, rootMargin: '600px 0px' });
    observer.observe(els.sentinel);
  }

  /* ---------- 다운로드 ---------- */
  function download() {
    if (!state.data || state.busy) return;
    state.busy = true;
    els.btnDownload.disabled = true;
    els.dlProgress.hidden = false;
    els.dlProgress.querySelector('.bar').style.width = '0%';
    setDlStatus('표지를 준비하는 중…');

    var blocks = state.blocks;
    var opts = effectiveOpts();
    setTimeout(function () {
      window.CcfoliaCover.make({
        file: state.coverFile,
        title: opts.bookTitle || state.data.title,
        author: opts.author,
        fit: state.opts.coverFit,
        posX: state.opts.coverPosX / 100
      }).catch(function (err) {
        console.warn('표지 생성 실패, 자동 표지로 대체합니다', err);
        return window.CcfoliaCover.make({ file: null, title: opts.bookTitle || state.data.title, author: opts.author });
      }).then(function (cover) {
        opts.cover = cover;
        setDlStatus('EPUB을 만드는 중…');
        return window.CcfoliaEpub.build(blocks, state.data, opts, function (pct) {
          els.dlProgress.querySelector('.bar').style.width = Math.round(pct) + '%';
        });
      }).then(function (res) {
        var url = URL.createObjectURL(res.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = res.filename;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        setDlStatus('완료: ' + res.filename + ' (' + (res.blob.size / 1024 / 1024).toFixed(2) + ' MB, 본문 파일 ' + res.parts + '개, 아이콘 ' + res.images + '종)');
      }).catch(function (err) {
        var msg = (err && err.message) || String(err);
        if (msg === 'JSZIP_MISSING') msg = '압축 라이브러리(JSZip)를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.';
        setDlStatus('EPUB 생성 실패: ' + msg, true);
        console.error(err);
      }).finally(function () {
        state.busy = false;
        els.btnDownload.disabled = false;
        els.dlProgress.hidden = true;
      });
    }, 30);
  }

  /* ---------- 이벤트 ---------- */
  function bind() {
    els.fileInput.addEventListener('change', function () {
      handleFile(els.fileInput.files[0]);
      els.fileInput.value = '';
    });
    els.btnEmptyUpload.addEventListener('click', function () { els.fileInput.click(); });

    ['dragenter', 'dragover'].forEach(function (ev) {
      els.dropZone.addEventListener(ev, function (e) { e.preventDefault(); els.dropZone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      els.dropZone.addEventListener(ev, function (e) { e.preventDefault(); els.dropZone.classList.remove('is-over'); });
    });
    els.dropZone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(f);
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      if (els.dropZone.contains(e.target)) return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (/^image\//.test(f.type)) { setCoverFile(f); return; }
      handleFile(f);
    });

    els.bookTitle.addEventListener('input', function () {
      state.bookTitle = els.bookTitle.value;
      updateSummary();
    });
    els.bookAuthor.addEventListener('input', function () {
      state.opts.author = els.bookAuthor.value;
      saveOpts();
    });

    els.coverInput.addEventListener('change', function () {
      var f = els.coverInput.files[0];
      if (f) setCoverFile(f);
      els.coverInput.value = '';
    });
    els.coverRemove.addEventListener('click', function () { setCoverFile(null); });
    els.coverPosX.addEventListener('input', function () {
      var v = Number(els.coverPosX.value);
      state.opts.coverPosX = isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 50;
      saveOpts();
      updateCoverThumbFit();
    });
    els.coverFitGroup.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'cover-fit') {
        state.opts.coverFit = e.target.value === 'contain' ? 'contain' : 'cover';
        saveOpts();
        updateCoverThumbFit();
      }
    });

    els.optAvatar.addEventListener('change', function () {
      state.opts.showAvatar = els.optAvatar.checked;
      saveOpts(); syncOptionUI(); recompute();
    });
    els.optMerge.addEventListener('change', function () {
      state.opts.merge = els.optMerge.checked;
      saveOpts(); syncOptionUI(); recompute();
    });
    els.optMergeSplit.addEventListener('change', function () {
      state.opts.mergeSplitOnAvatarChange = els.optMergeSplit.checked;
      saveOpts(); recompute();
    });
    els.optTabs.addEventListener('change', function () {
      state.opts.groupByTab = els.optTabs.checked;
      saveOpts(); recompute();
    });

    els.chAll.addEventListener('click', function () { setAllChannels(true); });
    els.chNone.addEventListener('click', function () { setAllChannels(false); });
    els.btnDownload.addEventListener('click', download);
  }

  function init() {
    els.bookAuthor.value = state.opts.author;
    syncOptionUI();
    updateCoverThumbFit();
    setPanelsEnabled(false);
    bind();
    setupObserver();
  }

  init();
})();
