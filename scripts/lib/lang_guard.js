// scripts/lib/lang_guard.js
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULT = { rules: { default: { validate: false, min_items_ratio: 0.6 } } };

function loadLangRules() {
  const p = process.env.LANG_GUARD_FILE || path.join("data", "lang_rules.yaml");
  if (!fs.existsSync(p)) return DEFAULT;
  try { return yaml.load(fs.readFileSync(p, "utf8")) || DEFAULT; }
  catch (_) { return DEFAULT; }
}

function makeScriptRegex(scripts) {
  // Node 20 以降: Unicode property escapes OK (\p{Script=...})
  const parts = scripts.map(sc => `\\p{Script=${sc}}`);
  return new RegExp(`(?:${parts.join("|")})`, "u");
}

function validateEntryForLang(rules, lang, title, items) {
  const cfg = (rules.rules && rules.rules[lang]) || (rules.rules && rules.rules.default) || { validate: false };
  if (!cfg || cfg.validate === false) return true;

  const scripts = cfg.any_scripts || [];
  if (!scripts.length) return true; // スクリプト未指定なら通す

  const re = makeScriptRegex(scripts);
  const hasInTitle = re.test(title || "");
  const arr = Array.isArray(items) ? items : [];
  const hits = arr.filter(s => re.test(s || "")).length;
  const ratio = arr.length ? hits / arr.length : 0;
  const minr = cfg.min_items_ratio ?? (rules.rules.default?.min_items_ratio ?? 0.6);

  return !!(hasInTitle && ratio >= minr);
}

module.exports = {
  loadLangRules,
  validateEntry(lang, title, items) {
    const rules = loadLangRules();
    return validateEntryForLang(rules, lang, title, items);
  }
};
