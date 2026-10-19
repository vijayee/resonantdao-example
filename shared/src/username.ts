// Username normalization shared by every client-side auth path. History: a
// remote terminal injected a literal DEL into pasted usernames (Cc), and
// zero-widths/format characters (Cf) defeat trim() — both pass visual
// inspection and then fail CRABS' id charset or a server exact-key lookup.
// NBSP (U+00A0) is deliberately untouched here: it is Unicode whitespace, so
// String.prototype.trim removes it, and no other Zs character is known to
// ride in on this project's inputs.
export function sanitizeUsername(raw: string): string {
  return raw
    .replace(
      /[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180E}\u{115F}\u{1160}\u{034F}\u{2065}]/gu,
      '',
    )
    .trim();
}