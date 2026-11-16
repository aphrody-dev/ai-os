// Ready-made templates: a complete workflow the company copies then adapts (URLs, secrets, addresses). Outgoing message texts and prompts stay French: they are sample content for a French company.
import type { Definition } from "./schema";

export interface Modele {
  id: string;
  nom: string;
  description: string;
  /** Node types highlighted in the gallery. */
  categories: string[];
  definition: Definition;
}

const n = (
  id: string,
  type: string,
  nom: string,
  x: number,
  y: number,
  parametres: Record<string, unknown> = {},
): Definition["noeuds"][number] => ({
  id,
  type,
  nom,
  parametres,
  position: [x, y],
  desactive: false,
  continuerSurErreur: false,
  tentatives: 0,
  delaiEssaiMs: 1000,
});
const c = (de: string, vers: string, sortie = 0) => ({ de, vers, sortie });

export const MODELES: Modele[] = [
  {
    id: "facture-slack",
    nom: "Announce each issued invoice on Slack",
    description:
      "As soon as an invoice goes out, the team sees the customer, the number and the amount in its channel.",
    categories: ["auto", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.evenement", "Invoice issued", 0, 0, {
          types: ["document.emis"],
        }),
        n("facture", "logique.si", "Is it an invoice?", 280, 0, {
          conditions: [
            {
              gauche: "{{ $json.data.data.type }}",
              operateur: "egal",
              droite: "facture",
            },
          ],
          combinaison: "et",
        }),
        n("slack", "communication.slack", "Notify the team", 560, -80, {
          webhook: "{{ $secret.slack_ventes }}",
          texte:
            "Facture {{ $json.data.numero }} émise pour {{ $json.data.data.client.nom }} : {{ $json.data.totaux.ttcCents | centimes }}",
        }),
      ],
      connexions: [c("declencheur", "facture"), c("facture", "slack", 0)],
    },
  },
  {
    id: "paiement-merci",
    nom: "Thank the customer when the payment arrives",
    description:
      "A thank-you e-mail goes out from your mailbox as soon as a payment is recorded.",
    categories: ["auto", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.evenement", "Payment received", 0, 0, {
          types: ["paiement.enregistre"],
        }),
        n("document", "auto.requete", "Read the invoice", 280, 0, {
          methode: "GET",
          chemin: "/v1/documents/{{ $json.data.documentId }}",
        }),
        n("email", "logique.si", "Does the customer have an e-mail?", 560, 0, {
          conditions: [
            { gauche: "{{ $json.data.client.email }}", operateur: "non_vide" },
          ],
          combinaison: "et",
        }),
        n("mail", "communication.mail", "Thank", 840, -80, {
          a: "{{ $json.data.client.email }}",
          sujet: "Merci pour votre règlement de la facture {{ $json.numero }}",
          texte:
            "Bonjour {{ $json.data.client.nom }},\n\nNous avons bien reçu votre paiement pour la facture {{ $json.numero }}. Merci pour votre confiance.\n\n{{ $json.data.emetteur.nom }}",
        }),
      ],
      connexions: [
        c("declencheur", "document"),
        c("document", "email"),
        c("email", "mail", 0),
      ],
    },
  },
  {
    id: "retards-lundi",
    nom: "Unpaid invoices summary every Monday",
    description:
      "Every Monday at 8 am, the list of overdue invoices arrives in your mailbox, sorted by age.",
    categories: ["planifie", "auto", "donnees"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.planifie", "Monday 8 am", 0, 0, {
          cron: "0 8 * * 1",
          fuseau: "Europe/Paris",
        }),
        n("retards", "auto.requete", "Invoices to chase", 280, 0, {
          methode: "GET",
          chemin: "/v1/relances",
          eclater: true,
        }),
        n("tri", "donnees.trier", "Oldest first", 560, 0, {
          champ: "joursRetard",
          ordre: "decroissant",
        }),
        n("ligne", "donnees.definir", "Format", 840, 0, {
          champs: [
            {
              nom: "ligne",
              valeur:
                "{{ $json.numero }} · {{ $json.client.nom }} · {{ $json.resteCents | centimes }} · {{ $json.joursRetard }} j",
            },
          ],
          conserver: false,
        }),
        n("regrouper", "donnees.agreger", "Group", 1120, 0, {
          champ: "lignes",
          valeur: "ligne",
        }),
        n("mail", "communication.mail", "Send the summary", 1400, 0, {
          a: "{{ $secret.mail_gerant }}",
          sujet: "{{ $json.nombre }} factures en retard",
          texte: "{{ $json.lignes | joindre:'\n' }}",
        }),
      ],
      connexions: [
        c("declencheur", "retards"),
        c("retards", "tri"),
        c("tri", "ligne"),
        c("ligne", "regrouper"),
        c("regrouper", "mail"),
      ],
    },
  },
  {
    id: "formulaire-client",
    nom: "Create a customer from your website form",
    description:
      "Your contact form calls the webhook URL: the prospect becomes a customer in auto.",
    categories: ["webhook", "auto"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.webhook", "Form received", 0, 0, {
          reponse: "fin",
        }),
        n("valide", "donnees.filtrer", "Name and e-mail present", 280, 0, {
          conditions: [
            { gauche: "{{ $json.corps.nom }}", operateur: "non_vide" },
            {
              gauche: "{{ $json.corps.email }}",
              operateur: "correspond",
              droite: "^[^@\\s]+@[^@\\s]+$",
            },
          ],
          combinaison: "et",
        }),
        n("client", "auto.requete", "Create the customer", 560, 0, {
          methode: "POST",
          chemin: "/v1/clients",
          corps: {
            nom: "{{ $json.corps.nom }}",
            email: "{{ $json.corps.email }}",
            adresse: "{{ $json.corps.adresse | defaut:'' }}",
          },
        }),
      ],
      connexions: [c("declencheur", "valide"), c("valide", "client")],
    },
  },
  {
    id: "absence-telegram",
    nom: "Notify the manager of an absence request",
    description:
      "A leave request arrives on Telegram, with the dates and the employee concerned.",
    categories: ["auto", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.evenement", "Absence requested", 0, 0, {
          types: ["absence.demandee"],
        }),
        n(
          "telegram",
          "communication.telegram",
          "Message to the manager",
          280,
          0,
          {
            jeton: "{{ $secret.telegram_bot }}",
            chat: "{{ $secret.telegram_chat }}",
            texte:
              "Demande d'absence du {{ $json.data.debut | date }} au {{ $json.data.fin | date }}.",
          },
        ),
      ],
      connexions: [c("declencheur", "telegram")],
    },
  },
  {
    id: "ia-tri-messages",
    nom: "Sort incoming messages with a local model",
    description:
      "An Ollama model classifies each message received (quote, support, other) and sends it to the right channel.",
    categories: ["webhook", "ia", "logique"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.webhook", "Message received", 0, 0, {
          reponse: "fin",
        }),
        n("ia", "ia.texte", "Classify the message", 280, 0, {
          url: "http://localhost:11434/v1",
          modele: "llama3.2",
          systeme:
            'Classe le message dans une catégorie : "devis", "support" ou "autre". Réponds en JSON : {"categorie": "…", "resume": "…"}.',
          prompt: "{{ $json.corps.message }}",
          json: true,
        }),
        n("aiguillage", "logique.aiguillage", "By category", 560, 0, {
          valeur: "{{ $json.reponse.categorie }}",
          cas: ["devis", "support"],
        }),
        n("devis", "communication.slack", "Sales channel", 840, -120, {
          webhook: "{{ $secret.slack_ventes }}",
          texte: "Demande de devis : {{ $json.reponse.resume }}",
        }),
        n("support", "communication.slack", "Support channel", 840, 0, {
          webhook: "{{ $secret.slack_support }}",
          texte: "Support : {{ $json.reponse.resume }}",
        }),
      ],
      connexions: [
        c("declencheur", "ia"),
        c("ia", "aiguillage"),
        c("aiguillage", "devis", 0),
        c("aiguillage", "support", 1),
      ],
    },
  },
  {
    id: "veille-api",
    nom: "Monitor an API and alert on Discord",
    description:
      "Every hour, a web service is queried; an abnormal response triggers an alert.",
    categories: ["planifie", "reseau", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.planifie", "Every hour", 0, 0, {
          cron: "0 * * * *",
          fuseau: "Europe/Paris",
        }),
        n("http", "reseau.http", "Query the service", 280, 0, {
          methode: "GET",
          url: "https://auto.aphrody.com/health",
          echecSiErreur: false,
        }),
        n("ko", "logique.si", "Abnormal response?", 560, 0, {
          conditions: [
            {
              gauche: "{{ $json.statut }}",
              operateur: "superieur",
              droite: 299,
            },
          ],
          combinaison: "et",
        }),
        n("discord", "communication.discord", "Alert", 840, -80, {
          webhook: "{{ $secret.discord_alertes }}",
          texte:
            "Service en erreur : HTTP {{ $json.statut }} à {{ $maintenant | date:'iso' }}",
        }),
      ],
      connexions: [
        c("declencheur", "http"),
        c("http", "ko"),
        c("ko", "discord", 0),
      ],
    },
  },
  {
    id: "veille-rss",
    nom: "Watch: new articles of a feed summarized on Slack",
    description:
      "Every hour, the new articles of an RSS feed are summarized in one sentence by a local model, then published.",
    categories: ["planifie", "reseau", "ia", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.planifie", "Every hour", 0, 0, {
          cron: "0 * * * *",
          fuseau: "Europe/Paris",
        }),
        n("flux", "reseau.flux", "Read the feed", 280, 0, {
          url: "https://www.economie.gouv.fr/rss",
          max: 20,
        }),
        n("nouveaux", "donnees.nouveaux", "Only new ones", 560, 0, {
          champ: "id",
        }),
        n("resume", "ia.texte", "Summarize", 840, 0, {
          url: "http://localhost:11434/v1",
          modele: "llama3.2",
          systeme:
            "Résume l'article en une phrase en français, sans préambule.",
          prompt: "{{ $json.titre }}\n\n{{ $json.resume }}",
        }),
        n("slack", "communication.slack", "Publish", 1120, 0, {
          webhook: "{{ $secret.slack_veille }}",
          texte: "{{ $json.titre }} : {{ $json.reponse }} {{ $json.lien }}",
        }),
      ],
      connexions: [
        c("declencheur", "flux"),
        c("flux", "nouveaux"),
        c("nouveaux", "resume"),
        c("resume", "slack"),
      ],
    },
  },
  {
    id: "questions-documents",
    nom: "Answer questions with your documents",
    description:
      'A webhook receives a question; the closest passages of your knowledge base are retrieved, then a language model answers and cites its sources. Index your documents first with "Index into the knowledge base".',
    categories: ["webhook", "ia"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.webhook", "Question received", 0, 0, {
          reponse: "fin",
        }),
        n("recherche", "ia.rechercher", "Search the documents", 280, 0, {
          base: "documents",
          question: "{{ $json.corps.question }}",
          k: 4,
          api: "http://localhost:11434/v1",
          modele: "nomic-embed-text",
        }),
        n("reponse", "ia.texte", "Answer", 560, 0, {
          url: "http://localhost:11434/v1",
          modele: "llama3.2",
          systeme:
            "Tu réponds en français à partir des extraits fournis seulement, en citant la source entre crochets. Si les extraits ne contiennent pas la réponse, dis-le simplement.",
          prompt:
            "Extraits :\n\n{{ $json.contexte }}\n\nQuestion : {{ $json.corps.question }}",
        }),
        n("sortie", "donnees.definir", "Webhook response", 840, 0, {
          champs: [
            { nom: "reponse", valeur: "{{ $json.reponse }}" },
            { nom: "sources", valeur: "{{ $json.resultats }}" },
          ],
          conserver: false,
        }),
      ],
      connexions: [
        c("declencheur", "recherche"),
        c("recherche", "reponse"),
        c("reponse", "sortie"),
      ],
    },
  },
];
