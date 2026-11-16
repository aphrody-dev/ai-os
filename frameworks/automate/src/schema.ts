// Definition of a workflow: a directed acyclic graph of typed nodes, linked output → input. A single trigger per
// workflow; its starting items come from the event, the cron, the webhook or the manual start. Validated by Zod
// in the API, the worker and the editor.
import { z } from "zod";

export const ID_NOEUD = /^[a-z0-9_-]{1,40}$/i;

export const Noeud = z.object({
  id: z.string().regex(ID_NOEUD, "identifier: letters, digits, - and _"),
  type: z.string().min(3).max(60),
  nom: z.string().trim().min(1).max(80),
  parametres: z.record(z.string(), z.unknown()).default({}),
  /** Position in the editor (px). */
  position: z.tuple([z.number(), z.number()]).default([0, 0]),
  desactive: z.boolean().default(false),
  /** An error does not stop the run: the item continues with an `erreur` field. */
  continuerSurErreur: z.boolean().default(false),
  /** Retries of a failed item (network error, service unavailable...), before the final error. */
  tentatives: z.number().int().min(0).max(5).default(0),
  /** Wait between two attempts (ms), doubled at each retry. */
  delaiEssaiMs: z.number().int().min(0).max(60_000).default(1000),
  note: z.string().max(2000).optional(),
});
export type Noeud = z.infer<typeof Noeud>;

export const Connexion = z.object({
  de: z.string().regex(ID_NOEUD),
  /** Index of the source node output (0: main; `logique.si`: 0 true, 1 false). */
  sortie: z.number().int().min(0).max(20).default(0),
  vers: z.string().regex(ID_NOEUD),
});
export type Connexion = z.infer<typeof Connexion>;

export const Definition = z.object({
  noeuds: z.array(Noeud).min(1).max(100),
  connexions: z.array(Connexion).max(400).default([]),
});
export type Definition = z.infer<typeof Definition>;

/** Item that flows between nodes (like an n8n item). */
export interface Element {
  json: Record<string, unknown>;
}

export type Declencheur = "manuel" | "evenement" | "planifie" | "webhook";

export const estDeclencheur = (type: string) => type.startsWith("declencheur.");
