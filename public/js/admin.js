(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var csrf = document.body.getAttribute('data-csrf');

  // mobile sidebar
  var sb = $('[data-asb]'); if (sb) sb.addEventListener('click', function () { $('#asb').classList.toggle('open'); });

  // confirm dialogs on forms / buttons
  document.addEventListener('submit', function (e) {
    var m = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (m && !window.confirm(m)) e.preventDefault();
  });

  // tabs
  $$('[data-tabs]').forEach(function (wrap) {
    var btns = $$('.tabs button', wrap), panes = $$('.pane', wrap);
    btns.forEach(function (b, i) { b.addEventListener('click', function () { btns.forEach(function (x) { x.classList.remove('on'); }); panes.forEach(function (p) { p.classList.remove('on'); }); b.classList.add('on'); panes[i].classList.add('on'); }); });
  });

  // ---------- rich text editor ----------
  function exec(cmd, val) { document.execCommand(cmd, false, val || null); }
  function embedUrl(u) {
    try {
      var x = new URL(u), h = x.hostname.replace(/^www\./, '');
      if (h === 'youtu.be') return 'https://www.youtube.com/embed/' + x.pathname.slice(1).split('/')[0];
      if ((h === 'youtube.com' || h === 'm.youtube.com') && x.pathname === '/watch' && x.searchParams.get('v')) return 'https://www.youtube.com/embed/' + x.searchParams.get('v');
      if (h === 'vimeo.com') { var m = x.pathname.match(/^\/(\d+)/); if (m) return 'https://player.vimeo.com/video/' + m[1]; }
    } catch (e) { /* invalid */ }
    return null;
  }
  var activeEd = null;
  $$('.ed').forEach(function (ed) {
    var ta = document.getElementById(ed.getAttribute('data-for'));
    ed.innerHTML = ta.value;
    ed.addEventListener('focus', function () { activeEd = ed; });
    ed.addEventListener('input', function () { ta.value = ed.innerHTML; });
    var tb = ed.previousElementSibling;
    tb.addEventListener('mousedown', function (e) { if (e.target.tagName === 'BUTTON') e.preventDefault(); });
    tb.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      ed.focus(); activeEd = ed;
      var c = b.getAttribute('data-c');
      if (c === 'h2' || c === 'h3') exec('formatBlock', c);
      else if (c === 'p') exec('formatBlock', 'p');
      else if (c === 'quote') exec('formatBlock', 'blockquote');
      else if (c === 'link') { var u = window.prompt('URL (https://…)'); if (u && /^(https?:\/\/|mailto:)/i.test(u)) exec('createLink', u); }
      else if (c === 'unlink') exec('unlink');
      else if (c === 'img') openMedia(function (m) { exec('insertHTML', '<figure><img src="/uploads/' + (m.medium || m.file) + '" alt="' + (m.alt || '').replace(/"/g, '&quot;') + '"><figcaption>' + (m.caption || '') + '</figcaption></figure><p><br></p>'); ta.value = ed.innerHTML; });
      else if (c === 'video') { var v = window.prompt('YouTube / Vimeo URL'); var em = v && embedUrl(v); if (em) exec('insertHTML', '<div class="video"><iframe src="' + em + '" allowfullscreen></iframe></div><p><br></p>'); else if (v) window.alert('Unsupported video URL'); }
      else if (c) exec(c);
      ta.value = ed.innerHTML;
    });
  });
  // plain-text paste
  document.addEventListener('paste', function (e) {
    var t = e.target.closest && e.target.closest('.ed'); if (!t) return;
    e.preventDefault();
    var txt = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, txt);
  });
  // sync before submit
  $$('form[data-editor]').forEach(function (f) { f.addEventListener('submit', function () { $$('.ed', f).forEach(function (ed) { document.getElementById(ed.getAttribute('data-for')).value = ed.innerHTML; }); }); });

  // ---------- media picker ----------
  var modal = $('#mediaModal'), cb = null, only = 'image';
  function openMedia(fn, kind) {
    if (!modal) return; cb = fn; only = kind || 'image'; modal.classList.add('on'); load('');
  }
  function load(q) {
    var grid = $('#mediaGrid'); grid.textContent = '…';
    fetch('/admin/media/list.json?kind=' + only + '&q=' + encodeURIComponent(q), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (items) {
      grid.textContent = '';
      items.forEach(function (m) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'mi';
        var img = document.createElement('img'); img.src = '/uploads/' + (m.thumb || m.file); img.alt = ''; img.loading = 'lazy';
        var d = document.createElement('div'); d.textContent = m.original_name || m.file;
        b.appendChild(img); b.appendChild(d);
        b.addEventListener('click', function () { modal.classList.remove('on'); if (cb) cb(m); });
        grid.appendChild(b);
      });
      if (!items.length) grid.textContent = '—';
    });
  }
  if (modal) {
    $('[data-mclose]', modal).addEventListener('click', function () { modal.classList.remove('on'); });
    var ms = $('#mediaSearch'); if (ms) ms.addEventListener('input', function () { load(ms.value); });
    var up = $('#mediaUpload');
    if (up) up.addEventListener('change', function () {
      var fd = new FormData(); fd.append('_csrf', csrf); Array.prototype.forEach.call(up.files, function (f) { fd.append('files', f); });
      fetch('/admin/media/upload?json=1', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-csrf-token': csrf } }).then(function () { load(''); up.value = ''; });
    });
  }
  // featured image / generic pickers
  $$('[data-pick]').forEach(function (box) {
    var input = $('input[type=hidden]', box), prev = $('img', box), clear = $('[data-clear]', box);
    $('[data-open]', box).addEventListener('click', function () {
      openMedia(function (m) { input.value = m.id; prev.src = '/uploads/' + (m.thumb || m.file); prev.style.display = ''; }, box.getAttribute('data-pick'));
    });
    if (clear) clear.addEventListener('click', function () { input.value = ''; prev.style.display = 'none'; });
  });

  // ---------- settings: color preview / misc ----------
  $$('[data-slugify]').forEach(function () {});
})();
