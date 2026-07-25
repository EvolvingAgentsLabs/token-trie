// kernel/token_trie.js
// Token-trie grammar engine. Pre-tokenize all valid opcode strings, build a
// trie of token-ID sequences, and use it at sample time to constrain the
// model's output to grammar-valid completions.
//
// This sidesteps wllama bug #168 (its grammar state machine doesn't advance
// reliably for opcode-heavy grammars). We work at token-ID level — no text
// matching, no detokenize round-trips during sampling.

class TrieNode {
  constructor() {
    this.children = new Map();   // tokenId -> TrieNode
    this.isEnd = false;
    this.opcodeIndex = -1;       // which opcode this completes
    this.slot = null;            // SlotSpec, when this node opens a free region
  }
}

/**
 * A region of an opcode whose content is not enumerable.
 *
 * Everything else in the trie is a fixed sequence of token IDs, so the valid
 * next set is just `node.children.keys()`. A free string has no such set — any
 * token is legal as long as it does not contain the character that closes the
 * string. So a slot is expressed as a *predicate over decoded text* plus the
 * finite set of tokens that leave it.
 *
 * That predicate cannot be evaluated here: deciding whether token 8423 contains
 * a quote means detokenizing it, which is async and belongs to the backend. So
 * `getValidNextTokens` hands this object back and the sampler resolves it.
 * It is the one place the trie stops being purely token-level.
 *
 * Consequence worth stating plainly: inside a slot the grammar constrains the
 * *shape* of the output, not its content. The model cannot break out of the
 * string, and it cannot run past `maxTokens`. What it writes in there is its
 * own. That is the same guarantee GBNF gives, and no more.
 */
export class SlotSpec {
  /**
   * @param {object} o
   * @param {RegExp} o.forbid Decoded text matching this cannot appear as content.
   * @param {number} o.maxTokens Hard cap; at the cap only exit tokens remain valid.
   * @param {number} [o.minTokens] Below this, exit tokens are not offered.
   * @param {string} [o.name] For diagnostics.
   */
  constructor({ forbid, maxTokens, minTokens = 0, name = null }) {
    this.forbid = forbid;
    this.maxTokens = maxTokens;
    this.minTokens = minTokens;
    this.name = name;
    this.exitTokens = new Set();  // filled by insertWithSlots
    this.exitNode = null;
  }
}

/**
 * What `getValidNextTokens` returns when generation is inside a slot.
 *
 * Deliberately not a Set: membership depends on text the trie cannot see. The
 * sampler must decode candidates and call `allowsContent`.
 */
export class SlotConstraint {
  constructor(spec, tokensConsumed) {
    this.spec = spec;
    this.tokensConsumed = tokensConsumed;
  }

  /** Tokens that close the slot and resume the fixed grammar. */
  get exitTokens() {
    return this.spec.exitTokens;
  }

  /** May the slot still take content, or is it at its cap? */
  get canTakeContent() {
    return this.tokensConsumed < this.spec.maxTokens;
  }

  /** May the slot be closed here, or is it under its floor? */
  get canExit() {
    return this.tokensConsumed >= this.spec.minTokens;
  }

  /** Is this decoded token legal as slot content? */
  allowsContent(text) {
    return this.canTakeContent && !this.spec.forbid.test(text);
  }

  /**
   * The token to fall back on when nothing in top-K is usable.
   *
   * Always an exit token: closing the string is the only choice guaranteed to
   * keep the output grammatical. Content would be a guess.
   */
  get fallbackToken() {
    return this.spec.exitTokens.values().next().value ?? -1;
  }
}

export class TokenTrie {
  constructor() {
    this.root = new TrieNode();
    this.opcodes = [];           // [{ string, tokens, opcodeIndex, label }]
  }

  // Insert one opcode. `tokens` is the model's tokenization of `string`.
  // `label` is an optional cartridge-method tag for routing diagnostics.
  insert(string, tokens, label = null) {
    const opcodeIndex = this.opcodes.length;
    let node = this.root;
    for (const tok of tokens) {
      if (!node.children.has(tok)) node.children.set(tok, new TrieNode());
      node = node.children.get(tok);
    }
    node.isEnd = true;
    node.opcodeIndex = opcodeIndex;
    this.opcodes.push({ string, tokens, opcodeIndex, label });
    return opcodeIndex;
  }

  /**
   * Insert an opcode built from fixed segments with slots between them.
   *
   * `segments` alternates literal token arrays and SlotSpec instances, e.g.
   *   [tokensFor('<|call|>c.say {"text":"'), spec, tokensFor('"}<|/call|>\n')]
   *
   * The literal after a slot is what closes it: its first token becomes the
   * slot's exit, so leaving the free region and resuming the fixed grammar is
   * the same operation.
   */
  insertWithSlots(string, segments, label = null) {
    const opcodeIndex = this.opcodes.length;
    let node = this.root;
    let pendingSlot = null;

    for (const seg of segments) {
      if (seg instanceof SlotSpec) {
        if (pendingSlot) throw new Error('two slots in a row have no boundary between them');
        pendingSlot = seg;
        continue;
      }
      if (!Array.isArray(seg) || seg.length === 0) {
        throw new Error('a literal segment must be a non-empty token array');
      }

      if (pendingSlot) {
        // The slot lives on the node reached so far; the literal that follows
        // is its exit.
        node.slot = pendingSlot;
        pendingSlot.exitTokens.add(seg[0]);
        pendingSlot = null;
      }

      for (const tok of seg) {
        if (!node.children.has(tok)) node.children.set(tok, new TrieNode());
        node = node.children.get(tok);
      }
    }

    if (pendingSlot) throw new Error('an opcode cannot end inside a slot — it would never close');

    node.isEnd = true;
    node.opcodeIndex = opcodeIndex;
    this.opcodes.push({ string, tokens: null, opcodeIndex, label, hasSlot: true });
    return opcodeIndex;
  }

  /**
   * Walk the trie, returning the node and how many tokens have been consumed
   * inside the slot that is currently open (0 when not in one).
   */
  _walk(generatedTokens) {
    let node = this.root;
    let slotNode = null;
    let slotConsumed = 0;

    for (const tok of generatedTokens) {
      if (slotNode) {
        // Inside a slot: an exit token resumes the fixed grammar, anything
        // else is content the trie does not model.
        if (slotNode.slot.exitTokens.has(tok)) {
          const next = node.children.get(tok);
          if (!next) return { node: null };
          node = next;
          slotNode = null;
          slotConsumed = 0;
        } else {
          slotConsumed++;
        }
        continue;
      }

      if (!node.children.has(tok)) return { node: null };
      node = node.children.get(tok);
      if (node.slot) { slotNode = node; slotConsumed = 0; }
    }
    return { node, slotNode, slotConsumed };
  }

  // Valid next token IDs given tokens generated so far.
  // allowedSet: optional Set<number> of opcode indices to restrict to.
  // Returns a Set, or a SlotConstraint when generation is inside a free region.
  getValidNextTokens(generatedTokens, allowedSet = null) {
    const { node, slotNode, slotConsumed } = this._walk(generatedTokens);
    if (!node) return new Set();
    if (slotNode) return new SlotConstraint(slotNode.slot, slotConsumed);

    if (!allowedSet) return new Set(node.children.keys());
    const result = new Set();
    for (const [tokId, child] of node.children) {
      if (this._leadsToAllowed(child, allowedSet)) result.add(tokId);
    }
    return result;
  }

  _leadsToAllowed(node, allowedSet) {
    if (node.isEnd && allowedSet.has(node.opcodeIndex)) return true;
    for (const child of node.children.values()) {
      if (this._leadsToAllowed(child, allowedSet)) return true;
    }
    return false;
  }

  isComplete(generatedTokens) {
    const { node, slotNode } = this._walk(generatedTokens);
    // An opcode is not complete while a slot is still open, however much text
    // has accumulated — the closing literal has not been emitted yet.
    return !!node && !slotNode && node.isEnd;
  }

  getOpcodeIndex(generatedTokens) {
    const { node, slotNode } = this._walk(generatedTokens);
    if (!node || slotNode) return -1;
    return node.opcodeIndex;
  }

  getOpcodeString(opcodeIndex) {
    return this.opcodes[opcodeIndex]?.string ?? null;
  }

  getOpcodeLabel(opcodeIndex) {
    return this.opcodes[opcodeIndex]?.label ?? null;
  }

  size() { return this.opcodes.length; }
}
