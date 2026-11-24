'use strict';
const dict = { ar: require('./ar'), fr: require('./fr') };
const tr = (lang, key, vars) => {
  let s = (dict[lang] && dict[lang][key]) ?? dict.ar[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
};
module.exports = { dict, tr };
