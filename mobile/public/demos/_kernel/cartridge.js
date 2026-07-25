// kernel/cartridge.js
// A Cartridge declares a set of opcode strings the LLM-CPU is allowed to
// emit. The kernel turns the cartridge manifest into a TokenTrie at
// load-time by tokenizing each opcode string with the active model's
// tokenizer.
//
// Manifest schema: kernel/schemas/cartridge.manifest.schema.json

import { TokenTrie } from './token_trie.js';
import { resolveOpcodes } from './compile_opcodes.js';

export class Cartridge {
  /**
   * @param manifest parsed manifest.json
   * @param opts.baseUrl URL the manifest was fetched from. `args_schema` paths
   *   are resolved against it, so the opcode list can be compiled from the
   *   schema instead of hand-written into the manifest.
   * @param opts.loadSchema async (path) => schema — overrides baseUrl, for
   *   callers that are not fetching over HTTP (tests, Node).
   */
  constructor(manifest, opts = {}) {
    this.manifest = manifest;
    this.baseUrl = opts.baseUrl ?? null;
    this.loadSchema = opts.loadSchema ?? (this.baseUrl ? this.#fetchSchema.bind(this) : null);
    this.name = manifest.name;
    this.version = manifest.version ?? '0.0.0';
    this.description = manifest.description ?? '';
    this.methods = manifest.methods ?? {};
    this.halt = manifest.halt ?? [
      '<|halt|>status=success\n',
      '<|halt|>status=failure\n',
      '<|halt|>status=partial\n',
    ];
    // Maps populated after build():
    this.methodOpcodeIndices = new Map();   // methodName -> Set<opcodeIndex>
    this.haltOpcodeIndices = new Set();
    this.trie = null;
  }

  // Resolve `args_schema` relative to the manifest URL.
  async #fetchSchema(schemaPath) {
    const url = new URL(schemaPath, new URL(this.baseUrl, globalThis.location?.href)).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cartridge: cannot load args_schema ${url}: ${res.status}`);
    return res.json();
  }

  // Build the trie. tokenize is an async function (string -> Promise<number[]>).
  async build(tokenize) {
    this.trie = new TokenTrie();
    await this.buildInto(this.trie, tokenize);
    return this.trie;
  }

  /**
   * Insert this cartridge's opcodes into an existing trie.
   *
   * Split out so a CartridgeRegistry can put several cartridges into one trie.
   * The opcode strings already carry the cartridge name — `tetris.move` versus
   * `scavenger.move` — so sharing a trie needs no disambiguation; the wire
   * format did that work already.
   *
   * @param haltIndex optional Map<string, number> of halt strings already in
   *   the trie. Passing one deduplicates `<|halt|>status=success` across
   *   cartridges instead of inserting a private copy per cartridge.
   */
  async buildInto(trie, tokenize, haltIndex = null) {
    this.trie = trie;
    for (const [methodName, methodDef] of Object.entries(this.methods)) {
      const indices = new Set();
      const opcodes = await resolveOpcodes(this.name, methodName, methodDef, this.loadSchema);
      for (const opcodeString of opcodes) {
        const tokens = await tokenize(opcodeString);
        const idx = trie.insert(opcodeString, tokens, `${this.name}.${methodName}`);
        indices.add(idx);
      }
      this.methodOpcodeIndices.set(methodName, indices);
    }
    for (const haltString of this.halt) {
      let idx = haltIndex?.get(haltString);
      if (idx === undefined) {
        const tokens = await tokenize(haltString);
        idx = trie.insert(haltString, tokens, `__halt__`);
        haltIndex?.set(haltString, idx);
      }
      this.haltOpcodeIndices.add(idx);
    }
    return trie;
  }

  // Convenience: opcode index sets for phase control
  allMethodIndices() {
    const all = new Set();
    for (const set of this.methodOpcodeIndices.values()) {
      for (const idx of set) all.add(idx);
    }
    return all;
  }

  methodIndices(...methodNames) {
    const result = new Set();
    for (const name of methodNames) {
      const set = this.methodOpcodeIndices.get(name);
      if (set) for (const idx of set) result.add(idx);
    }
    return result;
  }

  haltIndices() {
    return new Set(this.haltOpcodeIndices);
  }
}

// Validate a manifest against the schema. Returns {ok: true} or {ok: false, errors: [...]}.
// Lightweight validator — covers the structural invariants that matter for the trie.
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  if (typeof manifest.name !== 'string' || !manifest.name.length) {
    errors.push('manifest.name is required (non-empty string)');
  }
  if (!manifest.methods || typeof manifest.methods !== 'object') {
    errors.push('manifest.methods is required (object)');
  } else {
    for (const [methodName, methodDef] of Object.entries(manifest.methods)) {
      // A method declares its opcodes one of two ways: an `args_schema` the
      // kernel compiles from, or an explicit `opcodes` array for the cases the
      // compiler cannot express yet. Neither is a broken manifest.
      const hasSchema = typeof methodDef.args_schema === 'string' && methodDef.args_schema.length > 0;
      const hasOpcodes = Array.isArray(methodDef.opcodes) && methodDef.opcodes.length > 0;

      if (!hasSchema && !hasOpcodes) {
        errors.push(`method "${methodName}": needs either "args_schema" or a non-empty "opcodes" array`);
        continue;
      }
      if (hasOpcodes) {
        for (let i = 0; i < methodDef.opcodes.length; i++) {
          const op = methodDef.opcodes[i];
          if (typeof op !== 'string' || !op.length) {
            errors.push(`method "${methodName}".opcodes[${i}]: must be a non-empty string`);
          }
        }
      }
    }
  }
  if (manifest.halt !== undefined) {
    if (!Array.isArray(manifest.halt)) {
      errors.push('manifest.halt must be an array of strings');
    } else {
      for (let i = 0; i < manifest.halt.length; i++) {
        if (typeof manifest.halt[i] !== 'string') {
          errors.push(`manifest.halt[${i}]: must be a string`);
        }
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
