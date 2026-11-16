# Interface languages

The editor is written in English. Every other language is one file in
`gateway/app/static/locales/<code>.js` that maps the English text to its
translation. A missing or empty entry shows the English text.

Languages today: English, Deutsch (`de`), Español (`es`), Français (`fr`),
简体中文 (`zh-CN`). The editor picks the language chosen in Settings, else the
first browser/system language it has, else English. The choice can be changed
in Settings → Language at any time, without reopening documents.

## In the code

- `index.html`: write plain English. Its text and its `title`, `aria-label`,
  `placeholder`, `alt` attributes are translated as the page loads. Mark
  anything that must stay as it is with `data-no-i18n`.
- Scripts (`app.js`, `signature.js`): every text shown to people goes through
  - `t("Saved to {path}", { path })` (values in `{name}` placeholders; `{app}`
    is the product name),
  - `tn(n, "{n} page", "{n} pages")` for counts,
  - `tc("context", "Open")` when the same English needs two translations,
  - `N_("Highlight")` in tables built when the script loads, translated with
    `t()` where they are shown.

  The first argument must be a plain double-quoted string: the tools below find
  the texts by looking for these calls.
- What is on screen when the language changes is rebuilt in the
  `i18n:change` listeners in `app.js` and `signature.js`.

## Tools

```bash
python3 scripts/i18n.py check   # missing / unused entries, placeholder mistakes (all languages)
python3 scripts/i18n.py sync    # after changing texts in the code: add new keys (empty), drop old ones
python3 scripts/i18n.py keys    # every English text with the place it is used
python3 scripts/check_ui_languages.py http://127.0.0.1:8090 sample.pdf /tmp/shots [width]
                                # opens the editor in every language, takes screenshots,
                                # reports untranslated or cut-off text and script errors
```

## Adding a language

1. Add it to `LANGUAGES` in `gateway/app/static/i18n.js` (code → name in that
   language).
2. Create `locales/<code>.js` with `I18N.register("<code>", {});`, add a
   `<script>` line for it in `index.html`, run `scripts/i18n.py sync`.
3. Fill in the values. Plurals use the CLDR forms of the language:
   `{"one": "{n} Seite", "other": "{n} Seiten"}`.
4. Add the language to the loading screen (`desktop/dist/index.html`, a few
   sentences) and run both checks.

Messages that come from the background services (error details) are English.
