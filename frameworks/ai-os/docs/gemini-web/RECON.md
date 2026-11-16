# gemini.google.com : relevé de bout en bout (2026-11-13)

Relevé fait dans le Chrome 157 du propriétaire (session Google ouverte), à partir de la page elle-même : Resource Timing, DOM,
CSSOM, variables globales. Il ne contient aucun secret : les URL sont réduites à leur chemin, sans cookies, en-têtes ni corps
de requête. Le relevé reproductible et indexé (SQLite FTS5) est `relay recon` (`packages/relay/src/recon.ts`).

## Pile

- Front : application Wiz/Closure « BardChatUi ». Indices : `WIZ_global_data`, `AF_initDataCallback` / `AF_dataServiceRequests`,
  `_F_toggles_default_BardChatUi`, `__TSR_ROUTER__`. Composants Angular Material (`mat-*`) et composants maison `gem-*`.
- Transport : HTTP/3 (`h3`) ; 221 ressources depuis 17 origines (`gemini.google.com`, `gemini.gstatic.com`, `www.gstatic.com`,
  `*.clients6.google.com`, `play.google.com`…).
- Page : 1 334 nœuds DOM, 63 éléments personnalisés, 24 scripts, 85 feuilles de style, 4 835 règles CSS.

## API observées

| Appel                                                                                       | Rôle observé                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /_/BardChatUi/data/batchexecute?rpcids=…`                                             | RPC batchexecute (Wiz) : 19 rpcids au chargement, `PCck7e`, `VxUbXb`, `aPya6c` à l'envoi d'un message |
| `POST geminiweb-pa.clients6.google.com/v1/processSession`                                   | suivi de session pendant la génération                                                                |
| `signaler-pa.clients6.google.com/punctual/v1/chooseServer`, `/punctual/multi-watch/channel` | canal de notifications                                                                                |
| `waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.Waa/Create`                         | attestation web (anti-abus)                                                                           |
| `/_/BardChatUi/cspreport`, `/cspreport/fine-allowlist`                                      | rapports CSP                                                                                          |

Rpcids au chargement : otAQ7b, sJBwce, DYBcR, aPya6c, GPRiHf, maGuAc, ESY5D, MaZiqc, VxUbXb, FQjvN, o30O0e, ozz5Z, K4WWud,
CNgdBe, I4z33b, cYRIkd, cCSu7, L5adhe, ku4Jyf.

## Interface pilotée par le relais

- Saisie : `rich-textarea .ql-editor`.
- Envoi : `button[aria-label="Send message"]`, ou `"Envoyer un message"` quand l'interface est en français.
- Réponse : dernier `model-response message-content`. La génération est en cours tant qu'un bouton d'arrêt est présent.
- Aller-retour mesuré : 10,5 s.

L'API interne (batchexecute, `processSession`) est protégée par l'attestation `Waa` et par des jetons de page. Le relais ne
l'appelle donc pas directement : il passe par l'interface (CDP), et par Antigravity (`agy`) pour les modèles Gemini 4 sans
navigateur.
