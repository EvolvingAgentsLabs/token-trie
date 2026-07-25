// kernel/registry.js
// Several cartridges sharing one trie, so a session can hold more than one
// skill at a time.
//
// PLAN.md phase 4. It was gated on phases 1–3 for a reason: a registry over
// hand-enumerated opcodes multiplies the hand-writing problem instead of
// solving it. With the trie compiled from schemas, adding a second cartridge
// costs nothing but its schema.
//
// Nothing here disambiguates method names, because the wire format already
// does. An opcode reads `<|call|>tetris.move …`, so `tetris.move` and
// `scavenger.move` are different strings and land on different trie branches
// without any help. dispatch.js parses the cartridge name back out, so routing
// across a registry needs no change either.

import { TokenTrie } from './token_trie.js';
import { Cartridge } from './cartridge.js';

export class CartridgeRegistry {
  constructor() {
    this.cartridges = new Map();   // name -> Cartridge
    this.trie = new TokenTrie();
    // Halt strings are identical across cartridges by default. Inserting a
    // private copy per cartridge would put three indistinguishable
    // `<|halt|>status=success` opcodes in one trie, and phase control would
    // have to carry all of them to mean "may halt".
    this._haltIndex = new Map();   // halt string -> opcode index
    this._built = false;
  }

  /**
   * Add a cartridge before building.
   *
   * @param {Cartridge|object} cartridge a Cartridge, or a manifest to wrap
   * @param {object} [opts] passed to the Cartridge constructor when given a manifest
   */
  add(cartridge, opts = {}) {
    if (this._built) {
      throw new Error('registry: add() before build(); the trie is already built');
    }
    const cart = cartridge instanceof Cartridge ? cartridge : new Cartridge(cartridge, opts);

    if (this.cartridges.has(cart.name)) {
      throw new Error(
        `registry: two cartridges named "${cart.name}". Names prefix every ` +
        `opcode, so duplicates would be indistinguishable on the wire.`,
      );
    }
    this.cartridges.set(cart.name, cart);
    return this;
  }

  /** Build one trie holding every cartridge. */
  async build(tokenize) {
    if (this._built) throw new Error('registry: already built');
    if (this.cartridges.size === 0) throw new Error('registry: nothing to build — add a cartridge first');

    for (const cart of this.cartridges.values()) {
      await cart.buildInto(this.trie, tokenize, this._haltIndex);
    }
    this._built = true;
    return this.trie;
  }

  get(name) {
    return this.cartridges.get(name) ?? null;
  }

  names() {
    return [...this.cartridges.keys()];
  }

  // ── Phase control ────────────────────────────────────────────────────────
  //
  // The sets below are what a caller passes as `allowedOpcodes`. Restricting
  // to one cartridge is the common case: the model holds several skills but
  // only one is relevant this turn.

  /** Every method opcode of one cartridge. */
  cartridgeIndices(name) {
    const cart = this.cartridges.get(name);
    if (!cart) throw new Error(`registry: no cartridge named "${name}"`);
    return cart.allMethodIndices();
  }

  /**
   * Specific methods, addressed as "cartridge.method".
   *
   * Qualified because a registry can hold two cartridges that both define
   * `move`, and an unqualified name would silently pick one.
   */
  methodIndices(...qualified) {
    const result = new Set();
    for (const q of qualified) {
      const dot = q.indexOf('.');
      if (dot < 1) {
        throw new Error(`registry: "${q}" must be qualified as "cartridge.method"`);
      }
      const cartName = q.slice(0, dot);
      const method = q.slice(dot + 1);
      const cart = this.cartridges.get(cartName);
      if (!cart) throw new Error(`registry: no cartridge named "${cartName}" (in "${q}")`);
      const set = cart.methodOpcodeIndices.get(method);
      if (!set) throw new Error(`registry: cartridge "${cartName}" has no method "${method}"`);
      for (const idx of set) result.add(idx);
    }
    return result;
  }

  /** Every method opcode across every cartridge. */
  allMethodIndices() {
    const all = new Set();
    for (const cart of this.cartridges.values()) {
      for (const idx of cart.allMethodIndices()) all.add(idx);
    }
    return all;
  }

  /** The shared halt opcodes. */
  haltIndices() {
    return new Set(this._haltIndex.values());
  }

  size() {
    return this.trie.size();
  }
}
