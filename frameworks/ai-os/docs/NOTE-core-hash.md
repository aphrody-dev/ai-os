# Note : hachage de contenu via @aphrody/core

`src/frameworks/ai-os/engines/knowledge-engine/src/hash.ts` (branche src `core/common-lib`, retiré lors du déplacement vers agent) remplaçait `ffi/blake3.ts` :

- BLAKE3 réel via `core_blake3_hex` (src/core/capi, bun:ffi), Linux et Windows ;
- repli `Bun.CryptoHasher("blake2b256")` explicitement étiqueté (`contentHash()` renvoie `{ algo, hex }`), alors que l'ancien code étiquetait le repli « blake3 ».

Aucun BLAKE3 trouvé dans `core/secrets` ni `src/research` : pour des clés de cache stables entre machines, importer `contentHash` de `@aphrody/core` (src/system/core-ts) plutôt que de réimplémenter.
