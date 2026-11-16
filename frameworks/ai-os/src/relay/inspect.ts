// relay inspect: survey of the Gemini interface in the relay's Chrome (selector diagnostic when Google changes the DOM).
import { Tab, launchBrowser } from "./cdp.ts";
await launchBrowser(true);
const tab = await Tab.open(
  "https://gemini.google.com/app",
  "https://gemini.google.com/",
);
console.log(
  JSON.stringify(
    await tab.eval(`({ url: location.href, lang: document.documentElement.lang, signedIn: !!document.querySelector('[aria-label*="Google Account" i], [aria-label*="Compte Google" i]'),
      editor: !!document.querySelector('rich-textarea .ql-editor'),
      buttons: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 40) })`),
    null,
    1,
  ),
);
tab.close();
