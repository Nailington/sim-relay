export function keyCode(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
  if (/^Digit[1-9]$/.test(code)) return Number(code[5]) + 29;
  const keys: Record<string, number> = {
    Digit0: 39,
    Enter: 40,
    Escape: 41,
    Backspace: 42,
    Tab: 43,
    Space: 44,
    Minus: 45,
    Equal: 46,
    BracketLeft: 47,
    BracketRight: 48,
    Backslash: 49,
    Semicolon: 51,
    Quote: 52,
    Backquote: 53,
    Comma: 54,
    Period: 55,
    Slash: 56,
    CapsLock: 57,
    Delete: 76,
    Home: 74,
    End: 77,
    PageUp: 75,
    PageDown: 78,
    ArrowRight: 79,
    ArrowLeft: 80,
    ArrowDown: 81,
    ArrowUp: 82,
    ControlLeft: 224,
    ShiftLeft: 225,
    AltLeft: 226,
    MetaLeft: 227,
    ControlRight: 228,
    ShiftRight: 229,
    AltRight: 230,
    MetaRight: 231,
  };
  if (/^F([1-9]|1[0-2])$/.test(code)) return 57 + Number(code.slice(1));
  return keys[code];
}
export function normalizedPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
) {
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
}
/** Parse a simctl argument list without a shell, including quoted names and URLs. */
export function parseCommand(text: string): string[] {
  const args: string[] = [];
  let word = '',
    quote = '',
    escaped = false,
    started = false;
  for (const c of text.trim()) {
    if (escaped) {
      word += c;
      escaped = false;
      started = true;
    } else if (c === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        args.push(word);
        word = '';
        started = false;
      }
    } else {
      word += c;
      started = true;
    }
  }
  if (quote || escaped) throw new Error('Close the quote or finish the escaped character.');
  if (started) args.push(word);
  if (!args.length) throw new Error('Enter a simctl subcommand.');
  if (args[0] === 'xcrun' || args[0] === 'simctl')
    throw new Error('Enter only the subcommand, for example: list devices.');
  return args;
}
