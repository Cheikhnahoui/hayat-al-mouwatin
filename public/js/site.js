(function () {
  var b = document.querySelector('[data-menu]'), n = document.getElementById('mainnav');
  if (b && n) b.addEventListener('click', function () { var o = n.classList.toggle('open'); b.setAttribute('aria-expanded', o ? 'true' : 'false'); });
  document.querySelectorAll('[data-copy]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      var u = el.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { el.textContent = el.getAttribute('data-done'); }).catch(function () { window.prompt('', u); });
    });
  });
  // remember the visitor's language choice
  document.querySelectorAll('a.langbtn').forEach(function (a) {
    a.addEventListener('click', function () { document.cookie = 'hm_lang=' + a.getAttribute('hreflang') + ';path=/;max-age=31536000;samesite=lax'; });
  });
})();
